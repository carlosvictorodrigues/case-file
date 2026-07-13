import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { indexSemantics } from "../src/core/case-service.js";
import type { CoverageManifest, PageLedgerEntry } from "../src/domain/types.js";
import type { EmbeddingClient } from "../src/embeddings/gemini-embedding-client.js";
import { ingestCase } from "../src/ingest/worker.js";
import { CaseJobStore } from "../src/jobs/job-store.js";
import { resumeIngestJob } from "../src/jobs/worker-runner.js";
import type { GeminiOcrClient, GeminiTranscription } from "../src/ocr/gemini-client.js";
import { assessOcrYield } from "../src/ocr/text-quality.js";
import { CaseIndex } from "../src/storage/index-db.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "stamp-only-"));
  dirs.push(d);
  return d;
}

// Transcrição REAL de campo (caso-2, pág. 864): foto de um termo de rescisão
// que o OCR "leu com sucesso" devolvendo só os carimbos digitais.
const STAMP_ONLY_TRANSCRIPTION = `Fls.: 489

Documento assinado eletronicamente por ISADORA MENDES RAMOS, em 06/01/2025, às 15:25:02 - 4cfffc5
https://pje.trt21.jus.br/pjekz/validacao/25010615245356400000021368216?instancia=1
Número do processo: 0000008-69.2025.5.21.0008
Número do documento: 25010615245356400000021368216

Este documento foi gerado pelo usuário 037.***.***-05 em 08/04/2026 18:06:29
Número do documento: 25041618293259000000147780152
https://pje.tjce.jus.br:443/pje2grau/Processo/ConsultaDocumento/listView.seam?x=25041618293259000000147780152
Assinado eletronicamente por: JULIANA MOTTER ARAUJO - 16/04/2025 18:29:32`;

const CONTENT_TRANSCRIPTION = `TERMO DE RESCISÃO DO CONTRATO DE TRABALHO
Empregador: REDESIM INVESTIMENTOS E COMERCIO LTDA
Empregado: MARCOS HENRIQUE PEREIRA
Data de admissão: 10/03/2022. Data de afastamento: 09/12/2024.
Verbas rescisórias: saldo de salário R$ 1.480,00; férias proporcionais R$ 986,66;
décimo terceiro proporcional R$ 1.233,33. Total bruto: R$ 3.699,99.
Num. 19477862 - Pág. 489 Assinado eletronicamente por: JULIANA MOTTER ARAUJO - 11/04/2025 15:16:10`;

async function makeScannedPdf(path: string, pages: number): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = pdf.addPage([500, 500]);
    p.drawText(".", { x: 50, y: 250, size: 8, font });
  }
  writeFileSync(path, await pdf.save());
}

function readLedger(root: string, caseId: string): PageLedgerEntry[] {
  return JSON.parse(
    readFileSync(join(root, caseId, "artifacts", "page_ledger.snapshot.json"), "utf8"),
  ) as PageLedgerEntry[];
}

function readCoverage(root: string, caseId: string): CoverageManifest {
  return JSON.parse(
    readFileSync(join(root, caseId, "artifacts", "coverage_manifest.json"), "utf8"),
  ) as CoverageManifest;
}

function clientReturning(texts: string[]): GeminiOcrClient & { calls: number } {
  return {
    calls: 0,
    async transcribePage(): Promise<GeminiTranscription> {
      const text = texts[Math.min(this.calls, texts.length - 1)];
      this.calls++;
      return { text, reading_confidence: 0.9 };
    },
  };
}

function fakeEmbedClient(): EmbeddingClient & { pdfItems: number; textItems: number } {
  return {
    pdfItems: 0,
    textItems: 0,
    async embedContents(input: {
      items: Array<{ text?: string; pdfBytes?: Uint8Array }>;
    }): Promise<number[][]> {
      return input.items.map((item) => {
        if (item.text !== undefined) this.textItems++;
        else this.pdfItems++;
        return [1, 0, 0, 0];
      });
    },
  };
}

describe("assessOcrYield", () => {
  it("classifica a transcrição real só-carimbos do caso-2 como stamp_only", () => {
    const result = assessOcrYield(STAMP_ONLY_TRANSCRIPTION);
    expect(result.yield).toBe("stamp_only");
    expect(result.useful_chars_beyond_stamps).toBeLessThan(120);
  });

  it("transcrição substantiva (mesmo com rodapé PJe no fim) é content", () => {
    expect(assessOcrYield(CONTENT_TRANSCRIPTION).yield).toBe("content");
  });

  it("texto curto SEM carimbos é content (página quase em branco legítima)", () => {
    expect(assessOcrYield("Recibo assinado em cartório.").yield).toBe("content");
  });
});

describe("falso-sucesso de OCR (só carimbos)", () => {
  it("marca ocr_yield stamp_only no ledger, avisa na cobertura e embeda visual", async () => {
    const root = tmpRoot();
    const pdf = join(root, "processo.pdf");
    await makeScannedPdf(pdf, 1);
    const client = clientReturning([STAMP_ONLY_TRANSCRIPTION]);

    await ingestCase(root, pdf, "caso-carimbo", {
      geminiApiKey: "fake-key-1234567890",
      ocr: { approvalPageThreshold: 100, client },
    });

    const ledger = readLedger(root, "caso-carimbo");
    expect(ledger[0].state).toBe("ocr_done");
    expect(ledger[0].ocr_yield).toBe("stamp_only");
    expect(ledger[0].ocr_prompt_version).toBeGreaterThanOrEqual(2);

    const coverage = readCoverage(root, "caso-carimbo");
    expect(coverage.pages_ocr_stamp_only).toEqual([1]);
    expect(coverage.warnings.join(" ")).toContain("carimbos digitais");
    // Não bloqueia a análise global: é caveat, não lacuna crítica.
    expect(coverage.global_analysis_allowed).toBe(true);

    // A página só é alcançável pela representação VISUAL.
    const embed = fakeEmbedClient();
    const result = await indexSemantics(root, "caso-carimbo", {
      maxCalls: 10,
      geminiApiKey: "fake-key-1234567890",
      client: embed,
    });
    expect(result.embedded_visual).toBe(1);
    expect(embed.pdfItems).toBe(1);
  });

  it("ledger legado (pré-v0.6.1): retomada re-OCRiza com prompt novo e substitui vetores velhos", async () => {
    const root = tmpRoot();
    const pdf = join(root, "processo.pdf");
    await makeScannedPdf(pdf, 1);
    const client = clientReturning([STAMP_ONLY_TRANSCRIPTION, CONTENT_TRANSCRIPTION]);
    const ocr = { approvalPageThreshold: 100, client };

    await ingestCase(root, pdf, "caso-legado", { geminiApiKey: "fake-key-1234567890", ocr });
    expect(client.calls).toBe(1);

    // Embeda o texto dos carimbos (simula o estado do caso-2 antes do fix).
    const embed = fakeEmbedClient();
    await indexSemantics(root, "caso-legado", {
      maxCalls: 10,
      geminiApiKey: "fake-key-1234567890",
      client: embed,
    });

    // Simula ledger legado: sem ocr_yield/ocr_prompt_version gravados.
    const dbPath = join(root, "caso-legado", "index", "case.sqlite");
    const store = await CaseJobStore.open(dbPath, root, join(root, "caso-legado", "artifacts"));
    const prior = store.listPages("caso-legado")[0];
    store.upsertPage({
      ...prior,
      ocr_yield: undefined,
      ocr_prompt_version: undefined,
      updated_at: new Date().toISOString(),
    });
    store.writeSnapshots("caso-legado");
    store.close();

    const resumed = await resumeIngestJob({
      root,
      caseId: "caso-legado",
      geminiApiKey: "fake-key-1234567890",
      ocr,
    });
    expect(resumed.status).toBe("done");
    // Re-OCR aconteceu (2ª chamada) e desta vez rendeu conteúdo.
    expect(client.calls).toBe(2);
    const ledger = readLedger(root, "caso-legado");
    expect(ledger[0].state).toBe("ocr_done");
    expect(ledger[0].ocr_yield).toBe("content");

    // O artefato .ocr.txt foi substituído pelo conteúdo real.
    const ocrTxt = readFileSync(
      join(root, "caso-legado", "pages", "page-000001.ocr.txt"),
      "utf8",
    );
    expect(ocrTxt).toContain("TERMO DE RESCISÃO");

    // Vetores do texto antigo (carimbos) foram removidos — nada aponta para
    // conteúdo que não existe mais; o próximo indexar_semantica re-embeda.
    const index = await CaseIndex.open(dbPath, root);
    try {
      const vectors = index.listVectors("gemini-embedding-2|retrieval-v1");
      expect(vectors).toHaveLength(0);
    } finally {
      index.close();
    }

    // Retomada seguinte NÃO re-cobra: prompt atual já registrado.
    await resumeIngestJob({ root, caseId: "caso-legado", geminiApiKey: "fake-key-1234567890", ocr });
    expect(client.calls).toBe(2);
  });

  it("re-OCR que continua só-carimbo não entra em loop de re-cobrança", async () => {
    const root = tmpRoot();
    const pdf = join(root, "processo.pdf");
    await makeScannedPdf(pdf, 1);
    const client = clientReturning([STAMP_ONLY_TRANSCRIPTION]);
    const ocr = { approvalPageThreshold: 100, client };

    await ingestCase(root, pdf, "caso-loop", { geminiApiKey: "fake-key-1234567890", ocr });
    expect(client.calls).toBe(1);

    // Duas retomadas: nenhuma nova chamada — o prompt atual já foi tentado.
    await resumeIngestJob({ root, caseId: "caso-loop", geminiApiKey: "fake-key-1234567890", ocr });
    await resumeIngestJob({ root, caseId: "caso-loop", geminiApiKey: "fake-key-1234567890", ocr });
    expect(client.calls).toBe(1);
    expect(readLedger(root, "caso-loop")[0].ocr_yield).toBe("stamp_only");
  });
});
