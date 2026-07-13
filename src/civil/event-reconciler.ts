import { sha256, stableEventSignature } from "../domain/evidence.js";
import type { CivilEvent, RawCivilEvent } from "../domain/types.js";

export function reconcileCivilEvents(caseId: string, rawEvents: RawCivilEvent[]): CivilEvent[] {
  const groups = groupBy(rawEvents, fullKey);
  const ambiguousKeys = findAmbiguousBaseKeys(rawEvents);
  return [...groups.values()].map((events) =>
    mergeEvents(caseId, events, ambiguousKeys.has(basePageKey(events[0]))),
  );
}

function mergeEvents(caseId: string, events: RawCivilEvent[], ambiguous: boolean): CivilEvent {
  const evidenceIds = unique(events.flatMap((event) => event.evidence_ids)).sort(compareEvidenceIds);
  const canonicalEvidenceId = evidenceIds[0];
  const first = events[0];
  const canonicalTextHash = sha256(`${canonicalEvidenceId}|${first.descricao}`);
  const eventId = `evt-${sha256(
    stableEventSignature({
      case_id: caseId,
      tipo: first.tipo,
      subtipo: first.subtipo,
      modalidade: first.modalidade,
      data: first.data_documento ?? first.data_juntada,
      canonical_evidence_id: canonicalEvidenceId,
      canonical_text_hash: canonicalTextHash,
    }),
  ).slice(0, 12)}`;

  return {
    event_id: eventId,
    tipo: first.tipo,
    subtipo: first.subtipo,
    modalidade: first.modalidade,
    data_documento: first.data_documento,
    data_juntada: first.data_juntada,
    fonte_data: first.fonte_data,
    descricao: first.descricao,
    canonical_evidence_id: canonicalEvidenceId,
    evidence_ids: evidenceIds,
    reading_confidence: Math.min(...events.map((event) => event.reading_confidence)),
    extraction_confidence: Math.min(...events.map((event) => event.extraction_confidence)),
    ambiguities: ambiguous ? ["conflito de data para ato semelhante na mesma pagina"] : [],
    status: ambiguous ? "ambiguous" : "reconciled",
  };
}

function findAmbiguousBaseKeys(events: RawCivilEvent[]): Set<string> {
  const seen = new Map<string, Set<string>>();
  for (const event of events) {
    const key = basePageKey(event);
    const dates = seen.get(key) ?? new Set<string>();
    dates.add(`${event.data_documento ?? ""}|${event.data_juntada ?? ""}`);
    seen.set(key, dates);
  }
  return new Set([...seen.entries()].filter(([, dates]) => dates.size > 1).map(([key]) => key));
}

function fullKey(event: RawCivilEvent): string {
  return [
    event.tipo,
    event.subtipo ?? "",
    event.modalidade ?? "",
    event.data_documento ?? "",
    event.data_juntada ?? "",
  ].join("|");
}

function basePageKey(event: RawCivilEvent): string {
  return [
    event.tipo,
    event.subtipo ?? "",
    event.modalidade ?? "",
    event.evidence_ids[0]?.match(/:page:(\d+):/)?.[1] ?? "unknown",
  ].join("|");
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function compareEvidenceIds(left: string, right: string): number {
  const leftParts = evidenceSortParts(left);
  const rightParts = evidenceSortParts(right);
  return leftParts.page - rightParts.page || leftParts.unit.localeCompare(rightParts.unit);
}

function evidenceSortParts(evidenceId: string): { page: number; unit: string } {
  return {
    page: Number(evidenceId.match(/:page:(\d+):/)?.[1] ?? Number.MAX_SAFE_INTEGER),
    unit: evidenceId.match(/:unit:([^:]+)$/)?.[1] ?? "",
  };
}
