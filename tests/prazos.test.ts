import { describe, expect, it } from "vitest";
import { consultarPrazos, loadPrazosCiveis, prazoParaEventoRadar } from "../src/civil/prazos.js";
import { buildCivilProceduralRadar } from "../src/civil/radar.js";
import type { CivilEvent, CoverageManifest } from "../src/domain/types.js";

describe("tabela de prazos cíveis", () => {
  it("carrega a tabela curada versionada com base legal", () => {
    const file = loadPrazosCiveis();
    expect(file.versao).toBeTruthy();
    expect(file.prazos.length).toBeGreaterThanOrEqual(50);
    const contestacao = file.prazos.find((p) => p.id === "contestacao-procedimento-comum");
    expect(contestacao).toMatchObject({ prazo: "15 dias" });
    expect(contestacao?.base_legal).toContain("335");
  });

  it("filtra por ato com fold de acentos", () => {
    const resultado = consultarPrazos("contestação");
    expect(resultado.total).toBeGreaterThan(0);
    expect(resultado.prazos.every((p) => /contestacao/.test(p.id) || /contesta/i.test(p.tipo ?? ""))).toBe(
      true,
    );
  });

  it("evento de citação mapeia para o prazo de contestação do procedimento comum", () => {
    const prazo = prazoParaEventoRadar("citacao");
    expect(prazo).toMatchObject({ prazo: "15 dias" });
    expect(prazo?.base_legal).toContain("335");
    expect(prazo?.versao_tabela).toBeTruthy();
    expect(prazoParaEventoRadar("sentenca")).toBeUndefined();
  });
});

describe("radar com prazo de referência", () => {
  it("anexa prazo_referencia com base legal ao candidato de contestação", () => {
    const event: CivilEvent = {
      event_id: "evt-1",
      tipo: "citacao",
      fonte_data: "texto_do_documento",
      descricao: "citação do réu",
      evidence_ids: ["case:caso:page:2:unit:p001"],
      reading_confidence: 0.95,
      extraction_confidence: 0.8,
      canonical_evidence_id: "case:caso:page:2:unit:p001",
      ambiguities: [],
      status: "reconciled",
    };
    const coverage: CoverageManifest = {
      case_id: "caso",
      total_pages: 2,
      pages_read: 2,
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
    const radar = buildCivilProceduralRadar({ case_id: "caso", lado: "reu", events: [event], coverage });
    expect(radar.prazos_candidatos[0].prazo_referencia).toMatchObject({ prazo: "15 dias" });
    expect(radar.prazos_candidatos[0].prazo_referencia?.base_legal).toContain("335");
    // Continua candidato para conferência — nunca data final.
    expect(radar.prazos_candidatos[0].status).toBe("conferir");
  });
});
