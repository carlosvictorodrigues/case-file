import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ensureSinglePagePdfInput } from "../src/ocr/pdf-page-input.js";
import { runOcrForPage } from "../src/ocr/ocr-service.js";

describe("runOcrForPage", () => {
  it("creates a single-page PDF OCR input without native renderers", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocr-page-input-"));
    const pdfPath = join(root, "source.pdf");
    const pagesDir = join(root, "pages");
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([500, 500]).drawText("Pagina um", { x: 50, y: 420, size: 12, font });
    pdf.addPage([500, 500]).drawText("Pagina dois", { x: 50, y: 420, size: 12, font });
    writeFileSync(pdfPath, await pdf.save());

    const input = await ensureSinglePagePdfInput({
      sourcePdfPath: pdfPath,
      pagesDir,
      page: 2,
    });

    expect(input.mimeType).toBe("application/pdf");
    expect(input.relativePath).toBe("pages/page-000002.pdf");
    expect(input.bytes.length).toBeGreaterThan(100);
    expect(existsSync(input.absolutePath)).toBe(true);
  });

  it("marks pages skipped_no_key when OCR is needed without Gemini key", async () => {
    const result = await runOcrForPage({
      caseId: "caso",
      page: 1,
      pageText: "",
      pageTextPath: "pages/page-000001.txt",
      pagePdfPath: "pages/page-000001.pdf",
      geminiApiKey: undefined,
    });
    expect(result).toMatchObject({ state: "skipped_no_key", evidence: undefined });
  });

  it("creates OCR paragraph evidence with visual reference using an injectable client", async () => {
    const result = await runOcrForPage({
      caseId: "caso",
      page: 7,
      pageText: "",
      pageTextPath: "pages/page-000007.txt",
      pagePdfPath: "pages/page-000007.pdf",
      inputBytes: new Uint8Array([1, 2, 3]),
      mimeType: "application/pdf",
      geminiApiKey: "key",
      client: {
        async transcribePage() {
          return {
            text: "Mandado de citacao cumprido em 12/03/2025.",
            reading_confidence: 0.82,
            bbox: [0.1, 0.2, 0.9, 0.4],
          };
        },
      },
    });

    expect(result.state).toBe("ocr_done");
    expect(result.evidence).toMatchObject({
      evidence_id: "case:caso:page:7:unit:ocr001",
      unit_type: "ocr_paragraph",
      image_ref: { page_pdf_path: "pages/page-000007.pdf" },
      ocr: {
        provider: "google",
        model: "gemini-3.5-flash",
        reading_confidence: 0.82,
      },
    });
  });
});
