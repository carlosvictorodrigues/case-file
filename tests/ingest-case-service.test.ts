import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { sha256 } from "../src/domain/evidence.js";
import { ingestCase } from "../src/ingest/worker.js";
import {
  getCaseFile,
  getStatus,
  openEvidence,
  openPage,
  searchCase,
} from "../src/core/case-service.js";

async function makePdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p1 = pdf.addPage([500, 500]);
  p1.drawText("PETICAO INICIAL: autor juntou comprovante de pagamento.", {
    x: 50,
    y: 420,
    size: 12,
    font,
  });
  const p2 = pdf.addPage([500, 500]);
  p2.drawText("CONTESTACAO: reu alega prescricao e impugna dano moral.", {
    x: 50,
    y: 420,
    size: 12,
    font,
  });
  writeFileSync(path, await pdf.save());
}

describe("ingestCase", () => {
  it("creates workspace artifacts and searchable evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    const pdf = join(root, "processo.pdf");

    await makePdf(pdf);

    const created = await ingestCase(root, pdf, "caso-teste");
    expect(created.case_id).toBe("caso-teste");

    const coverage = JSON.parse(
      readFileSync(join(root, "caso-teste", "artifacts", "coverage_manifest.json"), "utf8"),
    ) as { global_analysis_allowed: boolean; total_pages: number };
    expect(coverage).toMatchObject({ global_analysis_allowed: true, total_pages: 2 });

    const ledger = JSON.parse(
      readFileSync(join(root, "caso-teste", "artifacts", "page_ledger.snapshot.json"), "utf8"),
    ) as Array<{ page: number; state: string; text_quality_score: number }>;
    expect(ledger.map((row) => row.state)).toEqual(["done", "done"]);
    expect(ledger[0].text_quality_score).toBeGreaterThan(0.5);

    const status = getStatus(root, "caso-teste");
    expect(status.status).toBe("done");
    expect(status.total_pages).toBe(2);

    const caseFile = getCaseFile(root, "caso-teste") as {
      case_id: string;
      cobertura?: { ocr_pendente: number };
    };
    expect(caseFile.case_id).toBe("caso-teste");
    expect(caseFile.cobertura?.ocr_pendente).toBe(0);

    const found = await searchCase(root, "caso-teste", "pagamento", 5);
    expect(found[0].evidence_id).toBe("case:caso-teste:page:1:unit:p001");

    const opened = await openEvidence(root, "caso-teste", found[0].evidence_id);
    expect(opened.text).toContain("comprovante");

    const page = await openPage(root, "caso-teste", 2);
    expect(page.text).toContain("prescricao");
  });

  it("keeps persisted page text aligned with evidence hash and offsets", async () => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    const pdf = join(root, "processo.pdf");

    await makePdf(pdf);

    await ingestCase(root, pdf, "caso-hash");

    const page = await openPage(root, "caso-hash", 1);
    const evidence = await openEvidence(root, "caso-hash", "case:caso-hash:page:1:unit:p001");

    expect(evidence.text).toBe(page.text);
    expect(evidence.hash).toBe(sha256(page.text));
    expect(evidence.start_offset).toBe(0);
    expect(evidence.end_offset).toBe(page.text.length);
  });

  it("surfaces low-text pages in both status and case file with an alert", async () => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    const pdf = join(root, "processo-curto.pdf");

    const shortPdf = await PDFDocument.create();
    const font = await shortPdf.embedFont(StandardFonts.Helvetica);
    const page = shortPdf.addPage([500, 500]);
    page.drawText("Curto", {
      x: 50,
      y: 420,
      size: 12,
      font,
    });
    writeFileSync(pdf, await shortPdf.save());

    await ingestCase(root, pdf, "caso-ocr");

    const status = getStatus(root, "caso-ocr");
    const caseFile = getCaseFile(root, "caso-ocr") as {
      case_id: string;
      cobertura?: { ocr_pendente: number };
      alerts: string[];
    };

    expect(status.needs_ocr_pages).toEqual([1]);
    expect(status.alerts).toHaveLength(1);
    expect(caseFile.cobertura?.ocr_pendente).toBe(1);
    expect(caseFile.alerts).toHaveLength(1);
  });
});
