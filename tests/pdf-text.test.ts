import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

async function makePdf(path: string, lines: string[]): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const line of lines) {
    const page = pdf.addPage([500, 500]);
    page.drawText(line, { x: 50, y: 420, size: 12, font });
  }
  writeFileSync(path, await pdf.save());
}

describe("extractPdfTextByPage", () => {
  it("resolves pdf.js standard fonts to the bundled standard_fonts directory", async () => {
    const { resolveStandardFontDataUrl, standardFontDataUrl } = await import("../src/ingest/pdf-text.js");
    const cwd = process.cwd();

    expect(standardFontDataUrl).toContain("/pdfjs-dist/standard_fonts/");
    expect(standardFontDataUrl).toMatch(/\/standard_fonts\/$/);

    process.chdir(tmpdir());
    try {
      const syntheticPackageJson = resolve(cwd, "node_modules/pdfjs-dist/package.json");
      const resolved = resolveStandardFontDataUrl(syntheticPackageJson);
      expect(resolved).toContain("/pdfjs-dist/standard_fonts/");
      expect(resolved).toMatch(/\/standard_fonts\/$/);
    } finally {
      process.chdir(cwd);
    }
  });

  it("extracts one text page per PDF page even when cwd changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdf-text-"));
    const path = join(dir, "processo.pdf");
    await makePdf(path, ["PETICAO INICIAL pagamento indevido", "CONTESTACAO prescricao"]);
    const cwd = process.cwd();

    process.chdir(tmpdir());
    try {
      const { extractPdfTextByPage } = await import("../src/ingest/pdf-text.js");
      const pages = await extractPdfTextByPage(path);
      expect(pages).toHaveLength(2);
      expect(pages[0].page).toBe(1);
      expect(pages[0].text).toContain("PETICAO INICIAL");
      expect(pages[0].needs_ocr).toBe(false);
      expect(pages[1].page).toBe(2);
      expect(pages[1].text).toContain("CONTESTACAO");
      expect(pages[1].needs_ocr).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  it("marks low-text pages for ocr", async () => {
    const { extractPdfTextByPage } = await import("../src/ingest/pdf-text.js");
    const dir = mkdtempSync(join(tmpdir(), "pdf-text-"));
    const path = join(dir, "processo-curto.pdf");
    await makePdf(path, ["Curto"]);
    const pages = await extractPdfTextByPage(path);

    expect(pages).toHaveLength(1);
    expect(pages[0].page).toBe(1);
    expect(pages[0].text).toContain("Curto");
    expect(pages[0].needs_ocr).toBe(true);
  });
});
