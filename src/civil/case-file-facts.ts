import type { CivilEvent, EvidenceUnit, PageLedgerEntry } from "../domain/types.js";
import { foldText } from "./text-fold.js";

export interface PartyCandidate {
  papel: "autor" | "reu";
  nome: string;
  evidence_id: string;
  confianca: number;
}

export interface CaseHeaderFacts {
  partes: PartyCandidate[];
  valor_causa?: { valor: string; evidence_id: string };
}

const AUTHOR_LABEL_RE =
  /\b(?:AUTOR(?:A)?|REQUERENTE|EXEQUENTE|RECLAMANTE|IMPETRANTE)\s*[:\-–]\s*([^\n,;]{3,80})/iu;
const DEFENDANT_LABEL_RE =
  /\b(?:R[ÉE]U?S?|R[ÉE]|REQUERID[OA]S?|EXECUTAD[OA]S?|RECLAMAD[OA]S?|IMPETRAD[OA]S?)\s*[:\-–]\s*([^\n,;]{3,80})/iu;
const EM_FACE_DE_RE = /\bem\s+face\s+d[eao]s?\s+([A-ZÀ-Ú][^,;.\n]{2,79})/u;
// Só sequências de palavras em CAIXA ALTA (com conectores DA/DE/DOS): é como
// nomes de parte aparecem em petição, e evita engolir texto corrido em volta
// ("O autor JOÃO DA SILVA, brasileiro" → captura só "JOÃO DA SILVA").
const QUALIFICATION_RE =
  /\b((?:[A-ZÀ-Ú][A-ZÀ-Ú']+)(?:\s+(?:DA|DE|DO|DAS|DOS|E|[A-ZÀ-Ú][A-ZÀ-Ú']+))*)\s*,\s*(?:brasileir[oa]|pessoa\s+jur[ií]dica|inscrit[oa]\s+no)/u;
const VALOR_CAUSA_RE = /valor\s+da\s+causa[^\dR$]{0,30}R?\$?\s*([\d][\d. ]*,\d{2})/iu;

// Cabeçalho do PJe vem numa linha só: a captura de "IMPETRANTE: FULANO
// IMPETRADO : SECRETÁRIO..." engolia o rótulo seguinte (achado de campo
// TJRJ), e "REQUERIDO: EMPRESA S/A DESPACHO" colava o título da seção.
// Cortamos o nome no próximo rótulo de parte/seção em CAIXA ALTA.
const NEXT_LABEL_RE =
  /\s+(?:(?:AUTOR(?:A)?S?|REQUERENTES?|EXEQUENTES?|RECLAMANTES?|IMPETRANTES?|R[ÉE]US?|REQUERID[OA]S?|EXECUTAD[OA]S?|RECLAMAD[OA]S?|IMPETRAD[OA]S?|INTERESSAD[OA]S?|ADVOGAD[OA]S?|DESPACHO|DECIS[ÃA]O|SENTEN[ÇC]A|CERTID[ÃA]O|INTIMA[ÇC][ÃA]O|CONCLUS[ÃA]O)\b(?=\s*[:\-–]|\s|$)|R[ÉE]\b(?=\s*[:\-–]))/u;

function cleanName(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const nextLabel = collapsed.match(NEXT_LABEL_RE);
  const cut = nextLabel?.index !== undefined ? collapsed.slice(0, nextLabel.index) : collapsed;
  return cut.replace(/[\s.,;:–-]+$/u, "").trim();
}

/**
 * Extração determinística e conservadora de partes e valor da causa a partir
 * das primeiras páginas. Cada fato carrega o evidence_id de origem e uma
 * confiança — candidatos para conferência, nunca conclusão.
 */
export function extractCaseHeaderFacts(units: EvidenceUnit[]): CaseHeaderFacts {
  const headUnits = units
    .filter((unit) => unit.unit_type === "page_text" && (unit.text?.length ?? 0) > 0)
    .sort((a, b) => a.page - b.page)
    .slice(0, 10);

  const byRole = new Map<PartyCandidate["papel"], PartyCandidate>();
  const propose = (candidate: PartyCandidate): void => {
    const current = byRole.get(candidate.papel);
    if (!current || candidate.confianca > current.confianca) {
      byRole.set(candidate.papel, candidate);
    }
  };
  let valorCausa: CaseHeaderFacts["valor_causa"];

  for (const unit of headUnits) {
    const text = unit.text ?? "";

    const authorLabel = text.match(AUTHOR_LABEL_RE);
    if (authorLabel) {
      propose({
        papel: "autor",
        nome: cleanName(authorLabel[1]),
        evidence_id: unit.evidence_id,
        confianca: 0.9,
      });
    }
    const defendantLabel = text.match(DEFENDANT_LABEL_RE);
    if (defendantLabel) {
      propose({
        papel: "reu",
        nome: cleanName(defendantLabel[1]),
        evidence_id: unit.evidence_id,
        confianca: 0.9,
      });
    }
    const emFaceDe = text.match(EM_FACE_DE_RE);
    if (emFaceDe) {
      propose({
        papel: "reu",
        nome: cleanName(emFaceDe[1]),
        evidence_id: unit.evidence_id,
        confianca: 0.8,
      });
    }
    const qualification = text.match(QUALIFICATION_RE);
    if (qualification) {
      propose({
        papel: "autor",
        nome: cleanName(qualification[1]),
        evidence_id: unit.evidence_id,
        confianca: 0.6,
      });
    }
    if (!valorCausa) {
      const valor = text.match(VALOR_CAUSA_RE);
      if (valor) {
        valorCausa = { valor: `R$ ${valor[1]}`, evidence_id: unit.evidence_id };
      }
    }
  }

  return { partes: [...byRole.values()], valor_causa: valorCausa };
}

const PIECE_LABELS: Record<string, string> = {
  inicial: "petição inicial",
  contestacao: "contestação",
  replica: "réplica",
  sentenca: "sentença",
  decisao: "decisão",
  recurso: "recurso",
  comprovante: "comprovante",
  procuracao: "procuração",
  documento_pessoal: "documento pessoal",
};

const EVENT_LABELS: Record<string, string> = {
  citacao: "citação",
  intimacao: "intimação",
  sentenca: "sentença",
  decisao: "decisão",
  contestacao: "contestação",
};

/**
 * Resumo ESTRUTURAL determinístico (não é resumo por LLM): sintetiza o que
 * as regras extraíram, sempre rastreável aos artefatos que o embasam.
 */
export function buildStructuralSummary(input: {
  totalPages: number;
  facts: CaseHeaderFacts;
  ledger: PageLedgerEntry[];
  events: CivilEvent[];
}): string {
  const parts: string[] = [`Processo cível com ${input.totalPages} página(s).`];

  const autor = input.facts.partes.find((parte) => parte.papel === "autor");
  const reu = input.facts.partes.find((parte) => parte.papel === "reu");
  if (autor || reu) {
    const nomes = [autor ? `autor: ${autor.nome}` : null, reu ? `réu: ${reu.nome}` : null]
      .filter(Boolean)
      .join("; ");
    parts.push(`Partes identificadas — ${nomes}.`);
  }

  const pieceCounts = new Map<string, number>();
  for (const entry of input.ledger) {
    const label = PIECE_LABELS[entry.piece_type];
    if (label) pieceCounts.set(label, (pieceCounts.get(label) ?? 0) + 1);
  }
  if (pieceCounts.size) {
    const listed = [...pieceCounts.entries()]
      .slice(0, 5)
      .map(([label, count]) => (count > 1 ? `${label} (${count} págs.)` : label))
      .join(", ");
    parts.push(`Peças identificadas: ${listed}.`);
  }

  const keyEvents = input.events
    .filter((event) => EVENT_LABELS[event.tipo] && (event.data_documento || event.data_juntada))
    .slice(0, 4)
    .map((event) => `${EVENT_LABELS[event.tipo]} em ${event.data_documento ?? event.data_juntada}`);
  if (keyEvents.length) {
    parts.push(`Eventos datados: ${keyEvents.join("; ")}.`);
  }

  if (input.facts.valor_causa) {
    parts.push(`Valor da causa: ${input.facts.valor_causa.valor}.`);
  }

  return parts.join(" ");
}

/** Conceitos jurídicos (folded) usados para sintetizar queries sem dados pessoais. */
const LEGAL_CONCEPTS = [
  "pagamento",
  "cobranca",
  "prescricao",
  "dano moral",
  "dano material",
  "multa contratual",
  "juros de mora",
  "citacao",
  "contestacao",
  "negativacao",
  "consumidor",
  "rescisao",
  "inadimplemento",
  "indenizacao",
  "repeticao de indebito",
  "tutela de urgencia",
  "honorarios",
  "revelia",
  "comprovante",
];

export function detectLegalConcepts(texts: string[]): string[] {
  const folded = foldText(texts.join(" \n "));
  return LEGAL_CONCEPTS.filter((concept) => folded.includes(concept));
}
