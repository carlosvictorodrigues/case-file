import type { EvidenceUnit, RawCivilEvent } from "../domain/types.js";
import { foldText } from "./text-fold.js";

const DATE_RE = /\b(\d{2})\/(\d{2})\/(\d{4})\b/g;

export function extractCivilEvents(input: {
  caseId: string;
  units: EvidenceUnit[];
}): RawCivilEvent[] {
  const events: RawCivilEvent[] = [];
  let counter = 1;

  for (const unit of input.units) {
    const text = unit.text ?? "";
    const folded = foldText(text);
    const tipo = inferType(folded);
    if (!tipo) continue;
    const dates = extractDates(text);
    if (!dates.length) continue;
    const source = unit.unit_type === "ocr_paragraph" ? "ocr" : "native";
    const dataJuntada = inferJuntadaDate(folded, dates);
    events.push({
      raw_event_id: `raw-${String(counter++).padStart(6, "0")}`,
      tipo,
      subtipo: tipo === "citacao" ? "mandado" : undefined,
      modalidade: inferModalidade(folded),
      data_documento: dates[0],
      data_juntada: dataJuntada,
      fonte_data: "texto_do_documento",
      descricao: text.slice(0, 240),
      evidence_ids: [unit.evidence_id],
      reading_confidence: source === "ocr" ? 0.75 : 0.95,
      extraction_confidence: 0.8,
      extraction: { source, method: "rule" },
    });
  }

  return events;
}

function inferType(folded: string): RawCivilEvent["tipo"] | undefined {
  if (/\bcitacao\b/.test(folded)) return "citacao";
  if (/\bintimacao\b/.test(folded)) return "intimacao";
  if (/\bsentenca\b/.test(folded)) return "sentenca";
  if (/\bdecisao\b/.test(folded)) return "decisao";
  if (/\bcontestacao\b/.test(folded)) return "contestacao";
  return undefined;
}

function inferModalidade(folded: string): string | undefined {
  if (/oficial de justica/.test(folded)) return "oficial_justica";
  if (/(publicacao|diario|dje)/.test(folded)) return "diario_justica";
  return undefined;
}

function extractDates(text: string): string[] {
  return [...text.matchAll(DATE_RE)].map((match) => `${match[3]}-${match[2]}-${match[1]}`);
}

function inferJuntadaDate(folded: string, dates: string[]): string | undefined {
  if (dates.length < 2) return undefined;
  if (/\bjuntad[oa]\b/.test(folded)) return dates[1];
  return undefined;
}
