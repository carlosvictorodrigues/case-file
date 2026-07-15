import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tabela de REFERÊNCIA "fase processual → peças tipicamente cabíveis",
 * curada e versionada — mesma filosofia da tabela de prazos: candidatos com
 * base legal para o advogado conferir, nunca ordem de protocolo nem data.
 * Curadoria: pesquisa multi-agente com verificação adversarial + checagem
 * da base legal contra a literalidade dos artigos (jul/2026).
 */
export interface PecaCabivel {
  peca: string;
  base_legal: string;
  quando: string;
  observacoes?: string | null;
}

export interface FaseTabela {
  area: "civil" | "penal";
  fase_id: string;
  fase: string;
  ordem: number;
  pecas: PecaCabivel[];
}

export interface FasesPecasFile {
  versao: string;
  escopo: string;
  fontes_curadoria: string[];
  fases: FaseTabela[];
}

let cache: FasesPecasFile | undefined;

export function loadFasesPecas(): FasesPecasFile {
  if (!cache) {
    const path = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "data",
      "fases-pecas.json",
    );
    cache = JSON.parse(readFileSync(path, "utf8")) as FasesPecasFile;
  }
  return cache;
}

/** Peças cabíveis da fase (e, opcionalmente, da fase seguinte na ordem). */
export function pecasDaFase(
  area: "civil" | "penal",
  faseId: string,
): { fase?: FaseTabela; versao: string } {
  const file = loadFasesPecas();
  const fase = file.fases.find((f) => f.area === area && f.fase_id === faseId);
  return { fase, versao: file.versao };
}

export function listarFases(area: "civil" | "penal"): FaseTabela[] {
  return loadFasesPecas()
    .fases.filter((f) => f.area === area)
    .sort((a, b) => a.ordem - b.ordem);
}
