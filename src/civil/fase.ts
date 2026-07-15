import type { PageLedgerEntry, PieceType } from "../domain/types.js";
import { citeDocument, type DocumentMap } from "./document-map.js";

/**
 * Detector DETERMINÍSTICO de fase processual: deriva a fase do que EXISTE no
 * caderno (peças classificadas), sempre com a peça-âncora que a comprova.
 * Nunca adivinha: caderno sem peças processuais classificadas = fase não
 * identificável. A fase descreve o que os autos mostram — a última
 * movimentação real pode estar à frente; a resposta diz isso.
 */

export interface FaseDetectada {
  area: "civil" | "penal";
  fase_id: string;
  fase: string;
  /** Peça que comprova a fase, com localização citável. */
  ancora?: { peca: string; paginas: string; citacao?: string };
  confianca: "alta" | "media";
  observacao: string;
}

const OBS_PADRAO =
  "Fase derivada das peças presentes no caderno preparado — a última movimentação real pode ser posterior; confirme no sistema do tribunal antes de agir.";

interface Regra {
  fase_id: string;
  fase: string;
  /** Peça-âncora (a mais avançada que caracteriza a fase). */
  ancora: PieceType;
  /** Peças que também precisam existir (ex.: recurso só é recursal APÓS sentença). */
  requer?: PieceType[];
  observacao?: string;
}

// Ordem importa: a primeira regra satisfeita (da mais avançada para a mais
// inicial) vence.
const REGRAS_CIVIL: Regra[] = [
  { fase_id: "recursal", fase: "Recursal", ancora: "recurso", requer: ["sentenca"] },
  { fase_id: "decisoria", fase: "Decisória (sentença proferida)", ancora: "sentenca" },
  { fase_id: "instrucao", fase: "Instrução (réplica apresentada)", ancora: "replica" },
  { fase_id: "defesa", fase: "Defesa apresentada (saneamento/instrução em curso)", ancora: "contestacao" },
  { fase_id: "postulatoria", fase: "Postulatória (inicial ajuizada)", ancora: "inicial" },
];

const REGRAS_PENAL: Regra[] = [
  { fase_id: "recursal", fase: "Recursal", ancora: "recurso", requer: ["sentenca"] },
  { fase_id: "decisoria", fase: "Decisória (sentença proferida)", ancora: "sentenca" },
  {
    fase_id: "decisoria",
    fase: "Decisória (alegações finais apresentadas; sentença pendente)",
    ancora: "alegacoes_finais",
  },
  { fase_id: "instrucao", fase: "Instrução (resposta à acusação apresentada)", ancora: "resposta_acusacao" },
  { fase_id: "acao-proposta", fase: "Ação penal proposta (denúncia no caderno)", ancora: "denuncia" },
];

const NOME_PECA: Partial<Record<PieceType, string>> = {
  inicial: "petição inicial",
  contestacao: "contestação",
  replica: "réplica",
  sentenca: "sentença",
  recurso: "recurso",
  denuncia: "denúncia",
  resposta_acusacao: "resposta à acusação",
  alegacoes_finais: "alegações finais",
};

function ancoraDe(
  ledger: PageLedgerEntry[],
  tipo: PieceType,
  mapa?: DocumentMap,
): { peca: string; paginas: string; citacao?: string } | undefined {
  const paginas = ledger.filter((e) => e.piece_type === tipo).map((e) => e.page);
  if (!paginas.length) return undefined;
  const min = Math.min(...paginas);
  const max = Math.max(...paginas);
  // Documento do mapa que contém a ÚLTIMA ocorrência (a mais recente nos autos).
  const doc = mapa?.documentos.find((d) => max >= d.first_page && max <= d.last_page);
  return {
    peca: NOME_PECA[tipo] ?? tipo,
    paginas: min === max ? `pág. ${max} do PDF` : `págs. ${min}-${max} do PDF`,
    citacao: doc ? citeDocument(doc) : undefined,
  };
}

export function detectarFase(
  area: "civil" | "penal",
  ledger: PageLedgerEntry[],
  mapa?: DocumentMap,
): FaseDetectada {
  const presentes = new Set(ledger.map((e) => e.piece_type));
  const regras = area === "penal" ? REGRAS_PENAL : REGRAS_CIVIL;

  for (const regra of regras) {
    if (!presentes.has(regra.ancora)) continue;
    if (regra.requer && !regra.requer.every((t) => presentes.has(t))) continue;
    const ancora = ancoraDe(ledger, regra.ancora, mapa);
    return {
      area,
      fase_id: regra.fase_id,
      fase: regra.fase,
      ancora,
      // Uma única peça-âncora sem as vizinhas esperadas = confiança média.
      confianca: regra.requer || presentes.size > 2 ? "alta" : "media",
      observacao: regra.observacao ?? OBS_PADRAO,
    };
  }

  return {
    area,
    fase_id: "nao-identificavel",
    fase: "Não identificável pelo caderno",
    confianca: "media",
    observacao:
      "Nenhuma peça processual classificada no caderno (comum em PDF sem separação de documentos). A fase pode ser apurada lendo as últimas decisões — busque por 'sentença', 'despacho' ou 'intimação' e confira as datas.",
  };
}
