import type {
  CivilEvent,
  CivilProceduralRadar,
  CoverageManifest,
  RadarConfidence,
  RadarItem,
} from "../domain/types.js";
import { prazoParaEventoRadar } from "./prazos.js";

function confidence(value: number): RadarConfidence {
  if (value >= 0.85) return "alta";
  if (value >= 0.6) return "media";
  return "baixa";
}

export function buildCivilProceduralRadar(input: {
  case_id: string;
  lado: "autor" | "reu";
  events: CivilEvent[];
  coverage: CoverageManifest;
  generated_at?: string;
}): CivilProceduralRadar {
  const prazos: RadarItem[] = [];
  const oportunidades: RadarItem[] = [];
  for (const event of input.events) {
    if (event.tipo === "citacao") {
      prazos.push({
        radar_id: `radar-${String(prazos.length + 1).padStart(4, "0")}`,
        tipo: "contestacao",
        status: "conferir",
        lado_favorecido: input.lado,
        hipotese: "Contestacao pode exigir conferencia de tempestividade.",
        eventos_base: [event.event_id],
        evidence_ids: event.evidence_ids,
        prazo_referencia: prazoParaEventoRadar(event.tipo),
        ressalvas: [
          "confirmar termo inicial",
          "confirmar modalidade de citacao",
          "confirmar data de juntada ou perfectibilizacao",
          "confirmar feriados locais",
          "contagem em dias uteis depende de calendario aplicavel",
        ],
        reading_confidence: confidence(event.reading_confidence),
        extraction_confidence: confidence(event.extraction_confidence),
      });
      oportunidades.push({
        radar_id: `radar-${String(oportunidades.length + 1).padStart(4, "0")}`,
        tipo: "intempestividade_adversaria",
        status: "conferir",
        lado_favorecido: input.lado,
        hipotese: "Ha indicio para conferir tempestividade de manifestacao adversaria.",
        eventos_base: [event.event_id],
        evidence_ids: event.evidence_ids,
        acao_sugerida: "Conferir calendario forense e avaliar preliminar.",
        reading_confidence: confidence(event.reading_confidence),
        extraction_confidence: confidence(event.extraction_confidence),
      });
    }
  }
  return {
    case_id: input.case_id,
    generated_at: input.generated_at ?? new Date().toISOString(),
    coverage: {
      global_analysis_allowed: input.coverage.global_analysis_allowed,
      critical_gaps: input.coverage.critical_gaps.length,
    },
    prazos_candidatos: prazos,
    oportunidades,
    lacunas: input.coverage.critical_gaps.map((gap) => gap.reason),
  };
}
