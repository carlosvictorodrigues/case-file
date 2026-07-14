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

/**
 * Número REAL de páginas do PDF — a verdade autoritativa do denominador.
 * Persistida na criação do caso: sem ela, "processadas == descobertas"
 * mascara truncamento como cobertura completa (incidente caso-3: worker
 * morto na pág. 2.485 de 8.405 reportava 2.485/2.485 "completo").
 */
export async function countPdfPages(pdfPath: string): Promise<number> {
  const data = new Uint8Array(readFileSync(pdfPath));
  const loadingTask = pdfjs.getDocument({
    data,
    standardFontDataUrl,
    useWorkerFetch: false,
    isEvalSupported: false,
  } as Parameters<typeof pdfjs.getDocument>[0] & { isEvalSupported: boolean });
  const doc = await loadingTask.promise;
  try {
    return doc.numPages;
  } finally {
    await loadingTask.destroy();
  }
}

export interface ExtractPdfOptions {
  /** Chamado após cada página varrida (extraída OU pulada) — heartbeat. */
  onPage?: (pageNo: number, totalPages: number) => void;
  /**
   * Páginas a PULAR (já lidas em runs anteriores). Seguro porque a cópia do
   * PDF no workspace é imutável desde a criação do caso — página 'done' não
   * precisa de re-extração nem re-hash na retomada. Torna cada janela de
   * vida do worker proporcional ao que FALTA, não ao tamanho do PDF.
   */
  skip?: ReadonlySet<number>;
}

export async function extractPdfTextByPage(
  pdfPath: string,
  options: ExtractPdfOptions = {},
): Promise<PdfPageText[]> {
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
      if (options.skip?.has(pageNo)) {
        options.onPage?.(pageNo, doc.numPages);
        continue;
      }
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
      options.onPage?.(pageNo, doc.numPages);
    }

    return pages;
  } finally {
    await loadingTask.destroy();
  }
}
