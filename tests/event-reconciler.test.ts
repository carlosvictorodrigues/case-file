import { describe, expect, it } from "vitest";
import { reconcileCivilEvents } from "../src/civil/event-reconciler.js";
import type { RawCivilEvent } from "../src/domain/types.js";

function raw(id: string, evidence_id: string, data = "2025-03-12"): RawCivilEvent {
  return {
    raw_event_id: id,
    tipo: "citacao",
    subtipo: "mandado",
    modalidade: "oficial_justica",
    data_documento: data,
    data_juntada: "2025-03-14",
    fonte_data: "texto_do_documento",
    descricao: "Mandado de citacao.",
    evidence_ids: [evidence_id],
    reading_confidence: 0.9,
    extraction_confidence: 0.8,
    extraction: { source: "native", method: "rule" },
  };
}

describe("reconcileCivilEvents", () => {
  it("merges clear duplicates and preserves all evidence ids", () => {
    const events = reconcileCivilEvents("caso", [
      raw("raw-1", "case:caso:page:44:unit:p001"),
      raw("raw-2", "case:caso:page:45:unit:p001"),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].evidence_ids).toEqual([
      "case:caso:page:44:unit:p001",
      "case:caso:page:45:unit:p001",
    ]);
  });

  it("keeps conflicting dates ambiguous instead of silently replacing ids", () => {
    const events = reconcileCivilEvents("caso", [
      raw("raw-1", "case:caso:page:44:unit:p001", "2025-03-12"),
      raw("raw-2", "case:caso:page:44:unit:p002", "2025-03-13"),
    ]);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.status === "ambiguous")).toBe(true);
  });
});
