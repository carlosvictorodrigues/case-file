import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildCoverageManifest } from "../src/core/coverage.js";
import { getStatus } from "../src/core/case-service.js";
import { makeTools } from "../src/tools.js";
import { createCaseJob } from "../src/ingest/worker.js";
import { countPdfPages, extractPdfTextByPage } from "../src/ingest/pdf-text.js";
import type { CaseStatus, OcrEstimate, PageLedgerEntry } from "../src/domain/types.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "coverage-honesta-"));
  dirs.push(d);
  return d;
}

async function makePdf(path: string, pages: number): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = pdf.addPage([500, 500]);
    p.drawText(`Pagina ${i + 1} com texto nativo suficiente para leitura.`, {
      x: 40,
      y: 250,
      size: 12,
      font,
    });
  }
  writeFileSync(path, await pdf.save());
}

function ledgerEntry(page: number): PageLedgerEntry {
  return {
    case_id: "caso",
    page,
    state: "done",
    text_quality_reasons: [],
    native_text_chars: 100,
    piece_type: "anexo",
    ocr_needed: false,
    ocr_attempts: 0,
    evidence_ids: [`case:caso:page:${page}:unit:p001`],
    updated_at: "2026-07-13T00:00:00.000Z",
  };
}

const ESTIMATE: OcrEstimate = { pages: 0, calls: 0, requires_approval: false, approved: true };

describe("denominador autoritativo (incidente caso-3: 8.405 págs viraram 2.485/2.485)", () => {
  it("countPdfPages devolve o total real e onPage é chamado por página", async () => {
    const root = tmpRoot();
    const pdf = join(root, "p.pdf");
    await makePdf(pdf, 4);
    expect(await countPdfPages(pdf)).toBe(4);

    const seen: number[] = [];
    await extractPdfTextByPage(pdf, { onPage: (page, total) => seen.push(page * 100 + total) });
    expect(seen).toEqual([104, 204, 304, 404]);
  });

  it("caso nasce com o total REAL persistido no manifest e no denominador do status", async () => {
    const root = tmpRoot();
    const pdf = join(root, "processo.pdf");
    await makePdf(pdf, 3);

    const created = await createCaseJob(root, pdf, "caso-total");
    const manifest = JSON.parse(
      readFileSync(join(root, created.case_id, "case.json"), "utf8"),
    ) as { total_pages_pdf?: number };
    expect(manifest.total_pages_pdf).toBe(3);

    const status = JSON.parse(
      readFileSync(join(root, created.case_id, "status.json"), "utf8"),
    ) as CaseStatus;
    expect(status.total_pages).toBe(3);
  });

  it("páginas nunca extraídas viram lacuna crítica e bloqueiam análise global", () => {
    const coverage = buildCoverageManifest({
      case_id: "caso",
      total_pages: 8405,
      pages: [1, 2, 3].map(ledgerEntry),
      ocr_estimate: ESTIMATE,
    });
    expect(coverage.total_pages).toBe(8405);
    expect(coverage.pages_never_extracted).toEqual({ count: 8402, intervalo: "4-8405" });
    expect(coverage.global_analysis_allowed).toBe(false);
    expect(coverage.critical_gaps.some((gap) => gap.kind === "ingest_incomplete")).toBe(true);
  });

  it("cobertura completa não inventa lacuna", () => {
    const coverage = buildCoverageManifest({
      case_id: "caso",
      total_pages: 3,
      pages: [1, 2, 3].map(ledgerEntry),
      ocr_estimate: ESTIMATE,
    });
    expect(coverage.pages_never_extracted).toBeUndefined();
    expect(coverage.global_analysis_allowed).toBe(true);
  });
});

describe("atestado de vida do worker no status", () => {
  function writeCase(
    root: string,
    caseId: string,
    status: CaseStatus,
    job: { last_heartbeat_at: string; heartbeat_deadline_ms: number },
  ): void {
    const caseDir = join(root, caseId);
    mkdirSync(join(caseDir, "artifacts"), { recursive: true });
    writeFileSync(join(caseDir, "status.json"), JSON.stringify(status));
    writeFileSync(join(caseDir, "artifacts", "ingest_job.json"), JSON.stringify(job));
  }

  const baseStatus: CaseStatus = {
    case_id: "caso-vida",
    status: "running",
    total_pages: 8405,
    processed_pages: 2485,
    needs_ocr_pages: [],
    alerts: [],
  };

  it("running com heartbeat vencido reporta worker INATIVO e manda retomar", () => {
    const root = tmpRoot();
    writeCase(root, "caso-vida", baseStatus, {
      last_heartbeat_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      heartbeat_deadline_ms: 30_000,
    });

    const status = getStatus(root, "caso-vida");
    expect(status.execucao).toContain("INATIVO");
    expect(status.proxima_acao).toContain("retomar_ingestao");
    expect(status.proxima_acao).toContain("seguro");
  });

  it("running com heartbeat fresco reporta worker ativo e manda AGUARDAR", () => {
    const root = tmpRoot();
    writeCase(root, "caso-vida", baseStatus, {
      last_heartbeat_at: new Date(Date.now() - 5_000).toISOString(),
      heartbeat_deadline_ms: 30_000,
    });

    const status = getStatus(root, "caso-vida");
    expect(status.execucao).toContain("worker ativo");
    expect(status.proxima_acao).toContain("aguardar");
  });

  it("retomar_ingestao recusa agendar por cima de worker vivo", async () => {
    const root = tmpRoot();
    writeCase(root, "caso-vida", baseStatus, {
      last_heartbeat_at: new Date(Date.now() - 5_000).toISOString(),
      heartbeat_deadline_ms: 30_000,
    });

    const tools = makeTools({ casesDir: root });
    const result = (await tools.retomar_ingestao({ case_id: "caso-vida" })) as {
      status: string;
      message: string;
    };
    expect(result.status).toBe("retomada_nao_agendada");
    expect(result.message).toContain("worker ativo");
  });
});
