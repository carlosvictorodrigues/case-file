import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { foldText } from "./text-fold.js";

/**
 * Tabela de REFERÊNCIA de prazos cíveis (CPC), curada e versionada — embarca
 * no bundle. Prazo é a informação mais sensível do produto: a fonte é esta
 * tabela auditável com base legal, NUNCA pesquisa em runtime. Toda entrega ao
 * usuário mantém status "conferir" + ressalvas; nenhuma data final é calculada.
 */
export interface PrazoReferencia {
  id: string;
  ato: string;
  prazo: string;
  unidade?: string | null;
  tipo?: string | null;
  definicao?: string | null;
  base_legal?: string | null;
  observacoes?: string | null;
  revisar?: boolean;
}

export interface PrazosCiveisFile {
  versao: string;
  escopo: string;
  fontes_curadoria: string[];
  prazos: PrazoReferencia[];
}

let cache: PrazosCiveisFile | undefined;

export function loadPrazosCiveis(): PrazosCiveisFile {
  if (!cache) {
    const path = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "data",
      "prazos-civel.json",
    );
    cache = JSON.parse(readFileSync(path, "utf8")) as PrazosCiveisFile;
  }
  return cache;
}

// Mapa CONSERVADOR evento-do-radar → entrada da tabela. Só ligamos o que o
// radar detecta com confiança; ampliar exige nova regra de detecção + revisão.
const RADAR_EVENT_TO_PRAZO_ID: Record<string, string> = {
  citacao: "contestacao-procedimento-comum",
};

export interface PrazoRadar {
  ato: string;
  prazo: string;
  unidade?: string | null;
  base_legal?: string | null;
  observacoes?: string | null;
  versao_tabela: string;
}

export function prazoParaEventoRadar(tipoEvento: string): PrazoRadar | undefined {
  const id = RADAR_EVENT_TO_PRAZO_ID[tipoEvento];
  if (!id) return undefined;
  const file = loadPrazosCiveis();
  const entry = file.prazos.find((prazo) => prazo.id === id);
  if (!entry) return undefined;
  return {
    ato: entry.ato,
    prazo: entry.prazo,
    unidade: entry.unidade,
    base_legal: entry.base_legal,
    observacoes: entry.observacoes,
    versao_tabela: file.versao,
  };
}

export function consultarPrazos(filtroAto?: string): {
  versao: string;
  escopo: string;
  total: number;
  prazos: PrazoReferencia[];
} {
  const file = loadPrazosCiveis();
  const folded = filtroAto ? foldText(filtroAto) : undefined;
  const prazos = folded
    ? file.prazos.filter(
        (prazo) =>
          foldText(prazo.ato).includes(folded) ||
          foldText(prazo.tipo ?? "").includes(folded) ||
          foldText(prazo.base_legal ?? "").includes(folded),
      )
    : file.prazos;
  return { versao: file.versao, escopo: file.escopo, total: prazos.length, prazos };
}
