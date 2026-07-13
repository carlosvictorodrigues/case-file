import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { authorizeOcr, getStatus } from "../src/core/case-service.js";
import { ingestCase } from "../src/ingest/worker.js";
import { resumeIngestJob } from "../src/jobs/worker-runner.js";
import type { GeminiOcrClient, GeminiTranscription } from "../src/ocr/gemini-client.js";
import type { PageLedgerEntry } from "../src/domain/types.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "runner-ocr-"));
  dirs.push(d);
  return d;
}

async function makeScannedPdf(path: string, pages: number): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = pdf.addPage([500, 500]);
    // Quase sem texto nativo (< 20 chars) => needs_ocr.
    p.drawText(".", { x: 50, y: 250, size: 8, font });
  }
  writeFileSync(path, await pdf.save());
}

interface CountingClient extends GeminiOcrClient {
  calls: number;
}

function okClient(): CountingClient {
  return {
    calls: 0,
    async transcribePage(): Promise<GeminiTranscription> {
      this.calls++;
      return { text: "TRANSCRICAO OCR DA PAGINA", reading_confidence: 0.9 };
    },
  };
}

function failFirstNCallsClient(failures: number): CountingClient {
  return {
    calls: 0,
    async transcribePage(): Promise<GeminiTranscription> {
      this.calls++;
      if (this.calls <= failures) {
        throw new Error("Gemini OCR failed with HTTP 429");
      }
      return { text: "TRANSCRICAO OCR DA PAGINA", reading_confidence: 0.9 };
    },
  };
}

function readLedger(root: string, caseId: string): PageLedgerEntry[] {
  return JSON.parse(
    readFileSync(join(root, caseId, "artifacts", "page_ledger.snapshot.json"), "utf8"),
  ) as PageLedgerEntry[];
}

describe("governanca de OCR no runner", () => {
  it("pausa aguardando aprovacao acima do threshold sem UMA chamada Gemini", async () => {
    const root = tmpRoot();
    const pdf = join(root, "processo.pdf");
    await makeScannedPdf(pdf, 3);
    const client = okClient();

    const created = await ingestCase(root, pdf, "caso-gate", {
      geminiApiKey: "fake-key-1234567890",
      ocr: { approvalPageThreshold: 2, client },
    });

    expect(created.status.status).toBe("paused_awaiting_ocr_approval");
    expect(client.calls).toBe(0);
    // Linguagem de orçamento (P18): o gate fala em REAIS, não em max_calls.
    const { getStatus } = await import("../src/core/case-service.js");
    const gate = getStatus(root, "caso-gate");
    expect(gate.custo_estimado_ocr).toContain("R$");
    expect(gate.custo_estimado_ocr).toContain("3 página(s)");
    expect(gate.proxima_acao).toContain("autorizar_ocr");
    const ledger = readLedger(root, "caso-gate");
    expect(ledger.map((row) => row.state)).toEqual(["ocr_needed", "ocr_needed", "ocr_needed"]);
  });

  it("apos autorizar_ocr respeita o teto de paginas e alerta o excedente", async () => {
    const root = tmpRoot();
    const pdf = join(root, "processo.pdf");
    await makeScannedPdf(pdf, 3);
    const client = okClient();
    const ocr = { approvalPageThreshold: 2, client };

    await ingestCase(root, pdf, "caso-teto", { geminiApiKey: "fake-key-1234567890", ocr });
    await authorizeOcr(root, "caso-teto", { max_pages: 2, max_calls: 10 });
    const resumed = await resumeIngestJob({
      root,
      caseId: "caso-teto",
      geminiApiKey: "fake-key-1234567890",
      ocr,
    });

    expect(client.calls).toBe(2);
    const ledger = readLedger(root, "caso-teto");
    expect(ledger.filter((row) => row.state === "ocr_done")).toHaveLength(2);
    expect(ledger.filter((row) => row.state === "ocr_needed")).toHaveLength(1);
    expect(resumed.status).toBe("done");
    const status = getStatus(root, "caso-teto");
    expect(status.alerts.join(" ")).toContain("Limite autorizado de OCR");
  });

  it("erro de OCR numa pagina nao aborta o job: retry e failed_retryable", async () => {
    const root = tmpRoot();
    const pdf = join(root, "processo.pdf");
    await makeScannedPdf(pdf, 3);
    // Página 1 falha nas 2 tentativas; páginas 2 e 3 sucedem.
    const client = failFirstNCallsClient(2);

    const created = await ingestCase(root, pdf, "caso-retry", {
      geminiApiKey: "fake-key-1234567890",
      // maxConcurrency 1: com pool, as falhas do fake se espalhariam
      // entre páginas e o cenário deixaria de ser determinístico.
      ocr: { approvalPageThreshold: 100, maxRetryAttempts: 2, maxConcurrency: 1, client },
    });

    expect(created.status.status).not.toBe("error");
    const ledger = readLedger(root, "caso-retry");
    expect(ledger[0].state).toBe("failed_retryable");
    expect(ledger[0].ocr_attempts).toBe(2);
    expect(ledger[0].ocr_last_error_message).toContain("429");
    expect(ledger[1].state).toBe("ocr_done");
    expect(ledger[2].state).toBe("ocr_done");
  });

  it("roda OCR em pool com o limite de concorrencia configurado", async () => {
    const root = tmpRoot();
    const pdf = join(root, "processo.pdf");
    await makeScannedPdf(pdf, 6);
    let inFlight = 0;
    let maxInFlight = 0;
    const client: CountingClient = {
      calls: 0,
      async transcribePage(): Promise<GeminiTranscription> {
        this.calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight--;
        return { text: "TRANSCRICAO OCR DA PAGINA", reading_confidence: 0.9 };
      },
    };

    await ingestCase(root, pdf, "caso-pool", {
      geminiApiKey: "fake-key-1234567890",
      ocr: { approvalPageThreshold: 100, maxConcurrency: 3, client },
    });

    expect(client.calls).toBe(6);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    const ledger = readLedger(root, "caso-pool");
    expect(ledger.every((row) => row.state === "ocr_done")).toBe(true);
  });

  it("pagina sem texto transcritivel vira failed_permanent e nao re-tenta no resume", async () => {
    const root = tmpRoot();
    const pdf = join(root, "processo.pdf");
    await makeScannedPdf(pdf, 1);
    const client: CountingClient = {
      calls: 0,
      async transcribePage(): Promise<GeminiTranscription> {
        this.calls++;
        return { text: "", reading_confidence: 0.6 };
      },
    };
    const ocr = { approvalPageThreshold: 100, maxRetryAttempts: 2, maxConcurrency: 1, client };

    await ingestCase(root, pdf, "caso-vazio", { geminiApiKey: "fake-key-1234567890", ocr });
    const ledger = readLedger(root, "caso-vazio");
    expect(ledger[0].state).toBe("failed_permanent");
    expect(ledger[0].ocr_last_error_kind).toBe("no_text_detected");
    expect(client.calls).toBe(2);

    // Resume não fica re-pagando página permanentemente sem texto.
    await resumeIngestJob({ root, caseId: "caso-vazio", geminiApiKey: "fake-key-1234567890", ocr });
    expect(client.calls).toBe(2);
  });

  it("retomar_ingestao nao re-cobra OCR ja feito (resume incremental)", async () => {
    const root = tmpRoot();
    const pdf = join(root, "processo.pdf");
    await makeScannedPdf(pdf, 2);
    const client = okClient();
    const ocr = { approvalPageThreshold: 100, client };

    await ingestCase(root, pdf, "caso-resume", { geminiApiKey: "fake-key-1234567890", ocr });
    expect(client.calls).toBe(2);

    const resumed = await resumeIngestJob({
      root,
      caseId: "caso-resume",
      geminiApiKey: "fake-key-1234567890",
      ocr,
    });
    expect(client.calls).toBe(2);
    expect(resumed.status).toBe("done");
  });

  it("sem chave marca skipped_no_key; com chave depois, retomar OCRiza", async () => {
    const root = tmpRoot();
    const pdf = join(root, "processo.pdf");
    await makeScannedPdf(pdf, 2);

    const created = await ingestCase(root, pdf, "caso-chave-depois", {
      ocr: { approvalPageThreshold: 100 },
    });
    expect(readLedger(root, "caso-chave-depois").map((row) => row.state)).toEqual([
      "skipped_no_key",
      "skipped_no_key",
    ]);
    expect(created.status.status).toBe("done");

    const client = okClient();
    const resumed = await resumeIngestJob({
      root,
      caseId: "caso-chave-depois",
      geminiApiKey: "fake-key-1234567890",
      ocr: { approvalPageThreshold: 100, client },
    });
    expect(resumed.status).toBe("done");
    expect(client.calls).toBe(2);
    expect(readLedger(root, "caso-chave-depois").map((row) => row.state)).toEqual([
      "ocr_done",
      "ocr_done",
    ]);
  });
});
