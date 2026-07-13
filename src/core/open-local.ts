import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stableCaseId } from "../domain/evidence.js";
import type { CaseManifest } from "../domain/types.js";
import { ensureSinglePagePdfInput } from "../ocr/pdf-page-input.js";
import { resolveInsideRoot } from "../storage/workspace.js";

/**
 * Vantagem do local-first: o servidor roda NA máquina do usuário, então ele
 * pode abrir o PDF da página no visualizador padrão (ou revelar no Explorer)
 * — "conferir no original" vira um clique, sem depender de o cliente de chat
 * permitir links file://. Segurança: o caminho NUNCA vem do chamador; é
 * derivado de case_id + número de página, sempre dentro da pasta autorizada.
 */

export type LocalOpener = (filePath: string, revelar: boolean) => void;

export function defaultOpener(filePath: string, revelar: boolean): void {
  const options = { detached: true, stdio: "ignore" as const };
  if (process.platform === "win32") {
    const child = revelar
      ? spawn("explorer", [`/select,${filePath}`], options)
      : spawn("explorer", [filePath], options);
    child.unref();
  } else if (process.platform === "darwin") {
    spawn("open", revelar ? ["-R", filePath] : [filePath], options).unref();
  } else {
    spawn("xdg-open", [filePath], options).unref();
  }
}

export interface OpenLocalResult {
  case_id: string;
  alvo: "pagina" | "processo";
  page?: number;
  arquivo: string;
  /** Ação SOLICITADA ao sistema; em ambiente sem interface gráfica pode não abrir. */
  acao: "abertura_solicitada" | "revelacao_solicitada";
  aviso: string;
}

export async function openOnComputer(
  root: string,
  caseId: string,
  input: { page?: number; alvo?: "pagina" | "processo"; revelar?: boolean },
  opener: LocalOpener = defaultOpener,
): Promise<OpenLocalResult> {
  const normalized = stableCaseId(caseId);
  const caseDir = resolveInsideRoot(root, join(root, normalized));
  if (!existsSync(caseDir)) {
    throw new Error(`ENOENT: case not found, open '${caseDir}'`);
  }
  const manifest = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")) as CaseManifest;

  const alvo = input.alvo ?? "pagina";
  let arquivo: string;
  let page: number | undefined;
  if (alvo === "processo") {
    arquivo = manifest.source_pdf;
  } else {
    if (!input.page || input.page < 1) {
      throw new Error("Informe a pagina (page >= 1) para abrir o PDF da pagina.");
    }
    page = Math.floor(input.page);
    // Gera (ou reusa) o PDF de página única — o mesmo artefato do OCR/embed
    // visual — sempre dentro de pages/ do caso.
    arquivo = await ensurePagePdf(root, caseDir, manifest.source_pdf, page);
  }

  const revelar = input.revelar ?? false;
  opener(arquivo, revelar);
  return {
    case_id: normalized,
    alvo,
    page,
    arquivo,
    acao: revelar ? "revelacao_solicitada" : "abertura_solicitada",
    aviso:
      (alvo === "pagina"
        ? "PDF de pagina unica extraido do processo original — confira o verbatim/imagem antes de citar."
        : "Abertura do PDF integral solicitada ao visualizador padrao.") +
      " Se nada abrir na tela (ex.: WSL/servidor sem interface grafica), abra manualmente o caminho em 'arquivo'.",
  };
}

/** Garante o artefato pages/page-NNNNNN.pdf e devolve o caminho absoluto. */
export async function ensurePagePdf(
  root: string,
  caseDir: string,
  sourcePdf: string,
  page: number,
): Promise<string> {
  const pagesDir = resolveInsideRoot(root, join(caseDir, "pages"));
  const artifact = await ensureSinglePagePdfInput({
    sourcePdfPath: sourcePdf,
    pagesDir,
    page,
  });
  return resolveInsideRoot(root, join(caseDir, artifact.relativePath));
}
