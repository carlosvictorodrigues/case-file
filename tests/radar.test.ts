import { describe, expect, it } from "vitest";
import { buildCivilProceduralRadar } from "../src/civil/radar.js";
import type { CivilEvent, CoverageManifest } from "../src/domain/types.js";

const coverage: CoverageManifest = {
  case_id: "caso",
  total_pages: 1,
  pages_read: 1,
  pages_pending: [],
  pages_ocr_needed: [],
  pages_ocr_done: [],
  pages_failed_retryable: [],
  pages_failed_permanent: [],
  pages_ocr_stamp_only: [],
  pages_unknown_unread: [],
  ocr_estimate: { pages: 0, calls: 0, requires_approval: false, approved: true },
  critical_gaps: [],
  global_analysis_allowed: true,
  warnings: [],
};

const citacao: CivilEvent = {
  event_id: "evt-1",
  tipo: "citacao",
  subtipo: "mandado",
  modalidade: "oficial_justica",
  data_documento: "2025-03-12",
  data_juntada: "2025-03-14",
  fonte_data: "texto_do_documento",
  descricao: "Mandado de citacao.",
  canonical_evidence_id: "case:caso:page:44:unit:p001",
  evidence_ids: ["case:caso:page:44:unit:p001"],
  reading_confidence: 0.7,
  extraction_confidence: 0.8,
  ambiguities: [],
  status: "reconciled",
};

describe("buildCivilProceduralRadar", () => {
  it("creates only candidate deadline language with separated confidences", () => {
    const radar = buildCivilProceduralRadar({
      case_id: "caso",
      lado: "autor",
      events: [citacao],
      coverage,
      generated_at: "2026-07-07T20:10:00.000Z",
    });

    expect(radar.prazos_candidatos[0]).toMatchObject({
      status: "conferir",
      tipo: "contestacao",
      reading_confidence: "media",
      extraction_confidence: "media",
    });
    expect(JSON.stringify(radar)).not.toMatch(/prazo perdido|esta prescrito|e intempestivo/i);
  });

  it("propagates coverage gaps into lacunas", () => {
    const radar = buildCivilProceduralRadar({
      case_id: "caso",
      lado: "autor",
      events: [],
      coverage: {
        ...coverage,
        global_analysis_allowed: false,
        critical_gaps: [
          {
            kind: "unknown_unread_potentially_critical",
            piece_type: "unknown",
            pages: [9],
            reason: "Pagina nao lida sem classificacao confiavel",
          },
        ],
      },
      generated_at: "2026-07-07T20:10:00.000Z",
    });
    expect(radar.lacunas[0]).toContain("Pagina nao lida");
  });
});
