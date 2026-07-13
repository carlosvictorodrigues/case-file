import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { indexSemantics, searchCaseHybrid } from "../src/core/case-service.js";
import type { EmbeddingClient } from "../src/embeddings/gemini-embedding-client.js";
import { ingestCase } from "../src/ingest/worker.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function makePdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = [
    "PETIÇÃO INICIAL: o autor juntou comprovante de pagamento da fatura e requer a condenação da ré.",
    "CERTIDÃO: a citação do réu foi realizada por oficial de justiça e a citação foi juntada aos autos.",
  ];
  for (const text of pages) {
    const p = pdf.addPage([595, 500]);
    p.drawText(text.slice(0, 90), { x: 30, y: 420, size: 10, font });
  }
  writeFileSync(path, await pdf.save());
}

/**
 * Embedder fake determinístico por trigramas de caracteres: palavras
 * aparentadas ("citado"/"citação") compartilham trigramas e portanto
 * têm cosseno alto — um stand-in testável para similaridade semântica.
 */
function trigramVector(text: string): number[] {
  const folded = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ");
  const vector = new Array<number>(128).fill(0);
  for (let i = 0; i < folded.length - 2; i++) {
    const tri = folded.slice(i, i + 3);
    let hash = 0;
    for (const ch of tri) hash = (hash * 31 + ch.charCodeAt(0)) % 128;
    vector[hash] += 1;
  }
  return vector;
}

class FakeEmbeddingClient implements EmbeddingClient {
  calls = 0;
  pdfItems = 0;
  textInputs: string[] = [];
  async embedContents(input: {
    items: Array<{ text?: string; pdfBytes?: Uint8Array }>;
  }): Promise<number[][]> {
    this.calls++;
    return input.items.map((item) => {
      if (item.text !== undefined) {
        this.textInputs.push(item.text);
        return trigramVector(item.text);
      }
      this.pdfItems++;
      // Vetor determinístico a partir dos bytes do PDF.
      return trigramVector(Buffer.from(item.pdfBytes ?? []).toString("base64").slice(0, 400));
    });
  }
}

describe("indexar_semantica + busca híbrida", () => {
  it("embeda com teto, é idempotente e a híbrida acha variação morfológica", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-"));
    dirs.push(root);
    const pdf = join(root, "processo.pdf");
    await makePdf(pdf);
    await ingestCase(root, pdf, "caso-sem");
    const client = new FakeEmbeddingClient();

    const first = await indexSemantics(root, "caso-sem", {
      maxCalls: 10,
      geminiApiKey: "fake-key-1234567890",
      client,
    });
    expect(first).toMatchObject({ embedded: 2, remaining: 0 });

    // Idempotente: nada a embedar, nenhuma chamada nova.
    const second = await indexSemantics(root, "caso-sem", {
      maxCalls: 10,
      geminiApiKey: "fake-key-1234567890",
      client,
    });
    expect(second).toMatchObject({ embedded: 0, calls_made: 0 });

    // "citado" não existe literalmente no texto ("citação") — a lexical não
    // acha; a semântica sim, e a página certa vem no topo.
    const hybrid = await searchCaseHybrid(root, "caso-sem", "citado", 5, {
      geminiApiKey: "fake-key-1234567890",
      client,
    });
    expect(hybrid.busca.modo).toBe("hibrida");
    expect(hybrid.results.length).toBeGreaterThan(0);
    expect(hybrid.results[0].page).toBe(2);
    expect(hybrid.results[0].snippet).toBeTruthy();
    // Dieta de contexto: o hit de conversa não carrega texto integral nem
    // metadados internos do índice (hash/offsets/paths).
    const keys = Object.keys(hybrid.results[0]);
    for (const interno of ["text", "hash", "start_offset", "end_offset", "source_path"]) {
      expect(keys).not.toContain(interno);
    }
  });

  it("respeita o teto de chamadas e continua de onde parou", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-cap-"));
    dirs.push(root);
    const pdf = join(root, "processo.pdf");
    await makePdf(pdf);
    await ingestCase(root, pdf, "caso-cap");
    const client = new FakeEmbeddingClient();

    const capped = await indexSemantics(root, "caso-cap", {
      maxCalls: 1,
      batchSize: 1,
      geminiApiKey: "fake-key-1234567890",
      client,
    });
    expect(capped).toMatchObject({ embedded: 1, remaining: 1, calls_made: 1 });

    const resumed = await indexSemantics(root, "caso-cap", {
      maxCalls: 5,
      batchSize: 1,
      geminiApiKey: "fake-key-1234567890",
      client,
    });
    expect(resumed).toMatchObject({ embedded: 1, remaining: 0 });
  });

  it("usa os formatos de retrieval do gemini-embedding-2 (documento e consulta)", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-fmt-"));
    dirs.push(root);
    const pdf = join(root, "processo.pdf");
    await makePdf(pdf);
    await ingestCase(root, pdf, "caso-fmt");
    const client = new FakeEmbeddingClient();

    await indexSemantics(root, "caso-fmt", {
      maxCalls: 10,
      geminiApiKey: "fake-key-1234567890",
      client,
    });
    expect(client.textInputs.every((t) => t.startsWith("title: none | text: "))).toBe(true);

    await searchCaseHybrid(root, "caso-fmt", "citação do réu", 5, {
      geminiApiKey: "fake-key-1234567890",
      client,
    });
    const queryInput = client.textInputs.at(-1);
    expect(queryInput).toBe("task: search result | query: citação do réu");
  });

  it("embeda páginas escaneadas visualmente (PDF de página única) antes do OCR", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-visual-"));
    dirs.push(root);
    const pdf = join(root, "processo.pdf");
    // Página 1 com texto nativo; página 2 quase vazia (fila de OCR).
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([595, 500]);
    p1.drawText("CERTIDÃO de citação do réu juntada aos autos do processo.", {
      x: 30,
      y: 420,
      size: 10,
      font,
    });
    const p2 = doc.addPage([595, 500]);
    p2.drawText(".", { x: 30, y: 250, size: 8, font });
    writeFileSync(pdf, await doc.save());
    await ingestCase(root, pdf, "caso-visual");
    const client = new FakeEmbeddingClient();

    const result = await indexSemantics(root, "caso-visual", {
      maxCalls: 10,
      geminiApiKey: "fake-key-1234567890",
      client,
    });
    expect(result.embedded).toBe(2);
    expect(result.embedded_visual).toBe(1);
    expect(client.pdfItems).toBe(1);

    // Idempotente também para o caminho visual.
    const again = await indexSemantics(root, "caso-visual", {
      maxCalls: 10,
      geminiApiKey: "fake-key-1234567890",
      client,
    });
    expect(again).toMatchObject({ embedded: 0, calls_made: 0 });
  });

  it("respeita o orçamento de TEMPO e continua na chamada seguinte (anti-timeout MCP)", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-budget-"));
    dirs.push(root);
    const pdf = join(root, "processo.pdf");
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 6; i++) {
      const p = doc.addPage([595, 500]);
      p.drawText(`Página ${i + 1}: certidão de citação do réu juntada aos autos do processo.`, {
        x: 30,
        y: 420,
        size: 10,
        font,
      });
    }
    writeFileSync(pdf, await doc.save());
    await ingestCase(root, pdf, "caso-budget");
    const slow: EmbeddingClient = {
      async embedContents(input: { items: Array<{ text?: string }> }): Promise<number[][]> {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return input.items.map(() => [1, 0, 0]);
      },
    };

    const first = await indexSemantics(root, "caso-budget", {
      maxCalls: 50,
      batchSize: 1,
      timeBudgetMs: 1,
      geminiApiKey: "fake-key-1234567890",
      client: slow,
    });
    // Progresso garantido (>= 1 lote), mas parou ANTES de terminar, com aviso.
    expect(first.embedded).toBeGreaterThanOrEqual(1);
    expect(first.remaining).toBeGreaterThan(0);
    expect(first.aviso).toContain("esgotado");

    const second = await indexSemantics(root, "caso-budget", {
      maxCalls: 50,
      geminiApiKey: "fake-key-1234567890",
      client: slow,
    });
    expect(second.remaining).toBe(0);
    expect(second.aviso).toBeUndefined();
  });

  it("hit semântico-only não mostra o rodapé PJe como trecho", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-excerpt-"));
    dirs.push(root);
    const pdf = join(root, "processo.pdf");
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([595, 500]);
    p1.drawText("PETIÇÃO INICIAL: o autor requer a condenação da ré ao pagamento.", {
      x: 30,
      y: 420,
      size: 10,
      font,
    });
    const p2 = doc.addPage([595, 500]);
    // Rodapé VEM PRIMEIRO na extração (como nas páginas reais do PJe).
    p2.drawText("Num. 222 - Pág. 1 Assinado eletronicamente por: ANA SILVA - 01/02/2024 10:00:00", {
      x: 30,
      y: 460,
      size: 7,
      font,
    });
    p2.drawText("A citação do réu foi realizada por oficial de justiça e juntada aos autos.", {
      x: 30,
      y: 300,
      size: 10,
      font,
    });
    writeFileSync(pdf, await doc.save());
    await ingestCase(root, pdf, "caso-excerpt");
    const client = new FakeEmbeddingClient();
    await indexSemantics(root, "caso-excerpt", {
      maxCalls: 10,
      geminiApiKey: "fake-key-1234567890",
      client,
    });

    // "citado" não existe literalmente — hit vem só da via semântica.
    const { results } = await searchCaseHybrid(root, "caso-excerpt", "citado", 5, {
      geminiApiKey: "fake-key-1234567890",
      client,
    });
    const hit = results.find((r) => r.page === 2);
    expect(hit).toBeDefined();
    expect(hit?.snippet).toBeTruthy();
    expect(hit?.snippet).not.toContain("Assinado eletronicamente");
    expect(hit?.snippet).toContain("oficial de justiça");
  });

  it("sem chave degrada para lexical com aviso ausente e sem chamadas", async () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-nokey-"));
    dirs.push(root);
    const pdf = join(root, "processo.pdf");
    await makePdf(pdf);
    await ingestCase(root, pdf, "caso-nokey");
    const client = new FakeEmbeddingClient();

    const result = await searchCaseHybrid(root, "caso-nokey", "pagamento", 5, { client });
    expect(result.busca.modo).toBe("lexical");
    expect(result.results.length).toBeGreaterThan(0);
    expect(client.calls).toBe(0);
  });
});
