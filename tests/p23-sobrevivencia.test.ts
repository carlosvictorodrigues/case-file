import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPdfTextByPage } from "../src/ingest/pdf-text.js";
import { createCaseJob, findInterruptedCases } from "../src/ingest/worker.js";
import { removerCaso, listCases } from "../src/core/case-service.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "p23-"));
  dirs.push(d);
  return d;
}

async function makePdf(path: string, pages: number): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = pdf.addPage([500, 500]);
    p.drawText(`Pagina ${i + 1} com texto nativo suficiente para leitura completa.`, {
      x: 40,
      y: 250,
      size: 12,
      font,
    });
  }
  writeFileSync(path, await pdf.save());
}

describe("extração incremental (janela do worker proporcional ao que falta)", () => {
  it("pula páginas do skip mas mantém o heartbeat varrendo todas", async () => {
    const root = tmpRoot();
    const pdf = join(root, "p.pdf");
    await makePdf(pdf, 3);

    const seen: number[] = [];
    const pages = await extractPdfTextByPage(pdf, {
      skip: new Set([1, 3]),
      onPage: (page) => seen.push(page),
    });
    expect(pages.map((p) => p.page)).toEqual([2]);
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("auto-retomada no boot: só casos interrompidos ou em erro", () => {
  function fakeCase(
    root: string,
    caseId: string,
    status: string,
    heartbeatAgeMs?: number,
  ): void {
    const caseDir = join(root, caseId);
    mkdirSync(join(caseDir, "artifacts"), { recursive: true });
    writeFileSync(join(caseDir, "case.json"), JSON.stringify({ case_id: caseId }));
    writeFileSync(
      join(caseDir, "status.json"),
      JSON.stringify({
        case_id: caseId,
        status,
        total_pages: 10,
        processed_pages: 4,
        needs_ocr_pages: [],
        alerts: [],
      }),
    );
    if (heartbeatAgeMs !== undefined) {
      writeFileSync(
        join(caseDir, "artifacts", "ingest_job.json"),
        JSON.stringify({
          last_heartbeat_at: new Date(Date.now() - heartbeatAgeMs).toISOString(),
          heartbeat_deadline_ms: 30_000,
        }),
      );
    }
  }

  it("pega zumbi e erro; ignora vivo, done e o gate de OCR", () => {
    const root = tmpRoot();
    fakeCase(root, "caso-zumbi", "running", 30 * 60_000);
    fakeCase(root, "caso-vivo", "running", 5_000);
    fakeCase(root, "caso-erro", "error");
    fakeCase(root, "caso-done", "done");
    fakeCase(root, "caso-gate", "paused_awaiting_ocr_approval");
    mkdirSync(join(root, "_lixeira", "caso-lixo"), { recursive: true });

    const interrompidos = findInterruptedCases(root)
      .map((item) => item.case_id)
      .sort();
    expect(interrompidos).toEqual(["caso-erro", "caso-zumbi"]);
  });
});

describe("remover_caso: lixeira local com confirmação", () => {
  it("move o caso para _lixeira/ e some do listar_casos", async () => {
    const root = tmpRoot();
    const pdf = join(root, "processo.pdf");
    await makePdf(pdf, 2);
    const created = await createCaseJob(root, pdf, "caso-lixo");

    const result = removerCaso(root, created.case_id, created.case_id);
    expect(result.movido_para).toContain("_lixeira");
    expect(existsSync(join(root, created.case_id))).toBe(false);
    expect(readdirSync(join(root, "_lixeira"))).toHaveLength(1);
    expect(listCases(root).casos.map((c) => c.case_id)).not.toContain(created.case_id);
  });

  it("recusa sem a confirmação exata", async () => {
    const root = tmpRoot();
    const pdf = join(root, "processo.pdf");
    await makePdf(pdf, 2);
    const created = await createCaseJob(root, pdf, "caso-fica");

    expect(() => removerCaso(root, created.case_id, "sim")).toThrow(/Confirmação inválida/);
    expect(existsSync(join(root, created.case_id))).toBe(true);
  });
});
