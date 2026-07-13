import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
// Ordem importa: os polyfills precisam existir antes do pdfjs avaliar.
import "./pdfjs-node-polyfills.js";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfPageText {
  page: number;
  text: string;
  needs_ocr: boolean;
}

const require = createRequire(import.meta.url);
const pdfjsPackageJsonPath = require.resolve("pdfjs-dist/package.json");

// Em Node puro o pdfjs resolve o worker sozinho, mas dentro do Electron
// (runtime do Claude Desktop, process.versions.electron definido) ele se
// considera "não-Node" e exige workerSrc explícito — sem isto, o bundle
// instalado falha com 'No "GlobalWorkerOptions.workerSrc" specified'.
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
).href;

export function resolveStandardFontDataUrl(pdfjsPackageJson: string): string {
  const pdfjsStandardFontsPath = resolve(dirname(pdfjsPackageJson), "standard_fonts");
  return pathToFileURL(`${pdfjsStandardFontsPath}/`).href;
}

export const standardFontDataUrl = resolveStandardFontDataUrl(pdfjsPackageJsonPath);

export async function extractPdfTextByPage(pdfPath: string): Promise<PdfPageText[]> {
  const data = new Uint8Array(readFileSync(pdfPath));
  const loadingTaskOptions = {
    data,
    standardFontDataUrl,
    useWorkerFetch: false,
    isEvalSupported: false
  } as Parameters<typeof pdfjs.getDocument>[0] & { isEvalSupported: boolean };

  const loadingTask = pdfjs.getDocument(loadingTaskOptions);
  const doc = await loadingTask.promise;

  try {
    const pages: PdfPageText[] = [];

    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      const text = content.items
        .map((item: unknown) => {
          const maybe = item as { str?: string };
          return maybe.str ?? "";
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      pages.push({
        page: pageNo,
        text,
        needs_ocr: text.length < 20
      });
    }

    return pages;
  } finally {
    await loadingTask.destroy();
  }
}
