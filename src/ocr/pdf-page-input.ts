import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";

export interface SinglePagePdfInput {
  absolutePath: string;
  relativePath: string;
  bytes: Uint8Array;
  mimeType: "application/pdf";
}

// Parse do PDF fonte UMA vez por processo, não uma vez por página: num
// processo de 1.359 páginas, re-parsear o arquivo inteiro a cada página de
// OCR era o custo dominante da fase B (bug de campo do caso-2/TJCE).
const sourceCache = new Map<string, Promise<PDFDocument>>();
const SOURCE_CACHE_MAX = 2;

function loadSourceDocument(sourcePdfPath: string): Promise<PDFDocument> {
  let cached = sourceCache.get(sourcePdfPath);
  if (!cached) {
    cached = PDFDocument.load(readFileSync(sourcePdfPath));
    sourceCache.set(sourcePdfPath, cached);
    if (sourceCache.size > SOURCE_CACHE_MAX) {
      const oldest = sourceCache.keys().next().value;
      if (oldest !== undefined) sourceCache.delete(oldest);
    }
  }
  return cached;
}

export async function ensureSinglePagePdfInput(input: {
  sourcePdfPath: string;
  pagesDir: string;
  page: number;
}): Promise<SinglePagePdfInput> {
  mkdirSync(input.pagesDir, { recursive: true });
  const fileName = `page-${String(input.page).padStart(6, "0")}.pdf`;
  const absolutePath = join(input.pagesDir, fileName);
  if (existsSync(absolutePath)) {
    return {
      absolutePath,
      relativePath: `pages/${fileName}`,
      bytes: readFileSync(absolutePath),
      mimeType: "application/pdf",
    };
  }

  const source = await loadSourceDocument(input.sourcePdfPath);
  if (input.page < 1 || input.page > source.getPageCount()) {
    throw new Error(`Page ${input.page} is outside PDF page range`);
  }
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(source, [input.page - 1]);
  out.addPage(copied);
  const bytes = await out.save();
  writeFileSync(absolutePath, bytes);
  return {
    absolutePath,
    relativePath: `pages/${fileName}`,
    bytes,
    mimeType: "application/pdf",
  };
}
