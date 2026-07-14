import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getStatus } from "../src/core/case-service.js";
import { ingestCase } from "../src/ingest/worker.js";
import type { GeminiOcrClient, GeminiTranscription } from "../src/ocr/gemini-client.js";
import type { CaseStatus } from "../src/domain/types.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "status-tokens-"));
  dirs.push(d);
  return d;
}

async function makeScannedPdf(path: string, pages: number): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = pdf.addPage([500, 500]);
    p.drawText(".", { x: 50, y: 250, size: 8, font });
  }
  writeFileSync(path, await pdf.save());
}

function tokenClient(): GeminiOcrClient {
  return {
    async transcribePage(): Promise<GeminiTranscription> {
      return {
        text: "TRANSCRICAO OCR DA PAGINA",
        reading_confidence: 0.9,
        tokens: { entrada: 300, saida: 500 },
      };
    },
  };
}

describe("custo real de OCR no status (feedback de campo)", () => {
  it("acumula os tokens cobrados e reporta custo_acumulado_ocr em reais", async () => {
    const root = tmpRoot();
    const pdf = join(root, "processo.pdf");
    await makeScannedPdf(pdf, 2);

    const created = await ingestCase(root, pdf, "caso-tokens", {
      geminiApiKey: "fake-key-1234567890",
      ocr: { client: tokenClient() },
    });
    expect(created.status.status).toBe("done");

    const status = getStatus(root, "caso-tokens");
    expect(status.ocr_tokens).toEqual({ entrada: 600, saida: 1000 });
    expect(status.custo_acumulado_ocr).toContain("R$");
    expect(status.custo_acumulado_ocr).toContain("já gastos");
  });

  it("sem tokens informados pela API, não inventa custo acumulado", async () => {
    const root = tmpRoot();
    const pdf = join(root, "processo.pdf");
    await makeScannedPdf(pdf, 1);
    const semTokens: GeminiOcrClient = {
      async transcribePage(): Promise<GeminiTranscription> {
        return { text: "TRANSCRICAO OCR DA PAGINA", reading_confidence: 0.9 };
      },
    };

    await ingestCase(root, pdf, "caso-sem-tokens", {
      geminiApiKey: "fake-key-1234567890",
      ocr: { client: semTokens },
    });

    const status = getStatus(root, "caso-sem-tokens");
    expect(status.ocr_tokens).toBeUndefined();
    expect(status.custo_acumulado_ocr).toBeUndefined();
  });
});

describe("compressão da lista de páginas pendentes (payload do chat)", () => {
  function writeStatusFixture(root: string, caseId: string, status: CaseStatus): void {
    mkdirSync(join(root, caseId), { recursive: true });
    writeFileSync(join(root, caseId, "status.json"), JSON.stringify(status, null, 2));
  }

  it("acima de 20 pendentes devolve as 10 primeiras + resumo com o intervalo", () => {
    const root = tmpRoot();
    const pendentes = Array.from({ length: 37 }, (_, i) => i + 101);
    writeStatusFixture(root, "caso-longo", {
      case_id: "caso-longo",
      status: "done",
      total_pages: 500,
      processed_pages: 463,
      needs_ocr_pages: pendentes,
      alerts: [],
    });

    const status = getStatus(root, "caso-longo");
    expect(status.needs_ocr_pages).toHaveLength(10);
    expect(status.needs_ocr_pages[0]).toBe(101);
    expect(status.needs_ocr_resumo).toContain("37 páginas escaneadas aguardando leitura");
    expect(status.needs_ocr_resumo).toContain("101–137");
    // A estimativa de custo continua contando TODAS as pendentes.
    expect(status.custo_estimado_ocr).toContain("37 página(s)");
  });

  it("lista curta passa intacta, sem resumo", () => {
    const root = tmpRoot();
    writeStatusFixture(root, "caso-curto", {
      case_id: "caso-curto",
      status: "done",
      total_pages: 10,
      processed_pages: 7,
      needs_ocr_pages: [2, 5, 9],
      alerts: [],
    });

    const status = getStatus(root, "caso-curto");
    expect(status.needs_ocr_pages).toEqual([2, 5, 9]);
    expect(status.needs_ocr_resumo).toBeUndefined();
  });
});
