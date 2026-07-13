import { describe, expect, it } from "vitest";
import { extractCivilEvents } from "../src/civil/event-extractor.js";
import type { EvidenceUnit } from "../src/domain/types.js";

function unit(text: string, unit_type: EvidenceUnit["unit_type"] = "page_text"): EvidenceUnit {
  return {
    evidence_id: "case:caso:page:44:unit:p001",
    case_id: "caso",
    page: 44,
    unit_id: "p001",
    unit_type,
    start_offset: 0,
    end_offset: text.length,
    hash: "h",
    text,
  };
}

describe("extractCivilEvents", () => {
  it("extracts citacao with modalidade, juntada, source, and separated confidences", () => {
    const events = extractCivilEvents({
      caseId: "caso",
      units: [unit("Mandado de citacao por oficial de justica em 12/03/2025, juntado em 14/03/2025.")],
    });
    expect(events[0]).toMatchObject({
      tipo: "citacao",
      modalidade: "oficial_justica",
      data_documento: "2025-03-12",
      data_juntada: "2025-03-14",
      fonte_data: "texto_do_documento",
      reading_confidence: 0.95,
      extraction_confidence: 0.8,
    });
  });

  it("extracts events from real accented Portuguese text", () => {
    const events = extractCivilEvents({
      caseId: "caso",
      units: [
        unit("Certidão de citação realizada em 10/05/2024, por oficial de justiça, juntada em 15/05/2024."),
        unit("SENTENÇA publicada no DJE em 20/06/2024."),
        unit("Decisão interlocutória proferida em 02/02/2024."),
      ],
    });
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      tipo: "citacao",
      modalidade: "oficial_justica",
      data_documento: "2024-05-10",
      data_juntada: "2024-05-15",
    });
    expect(events[1]).toMatchObject({ tipo: "sentenca", modalidade: "diario_justica" });
    expect(events[2]).toMatchObject({ tipo: "decisao" });
  });

  it("marks OCR events with lower reading confidence", () => {
    const events = extractCivilEvents({
      caseId: "caso",
      units: [unit("Intimacao publicada em 01/04/2025.", "ocr_paragraph")],
    });
    expect(events[0]).toMatchObject({
      tipo: "intimacao",
      extraction: { source: "ocr" },
      reading_confidence: 0.75,
    });
  });
});
