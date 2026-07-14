export type UnitType = "paragraph" | "page_text" | "image" | "ocr_paragraph";

export interface EvidenceImageRef {
  page_image_path?: string;
  page_pdf_path?: string;
  region_path?: string;
  bbox?: [number, number, number, number];
}

export interface OcrMetadata {
  provider: "google";
  model: string;
  reading_confidence: number;
  warning: string;
}

export interface EvidenceUnit {
  evidence_id: string;
  case_id: string;
  page: number;
  folio_label?: string;
  event_id?: string;
  display_ref?: string;
  unit_id: string;
  unit_type: UnitType;
  start_offset: number;
  end_offset: number;
  hash: string;
  source_path?: string;
  text?: string;
  image_ref?: EvidenceImageRef;
  ocr?: OcrMetadata;
}

export interface CaseManifest {
  case_id: string;
  area: "civil";
  source_pdf: string;
  created_at: string;
  /** Total REAL de páginas do PDF (numPages) — denominador autoritativo. */
  total_pages_pdf?: number;
}

export type IngestJobStatus =
  | "queued"
  | "running"
  | "paused"
  | "paused_awaiting_ocr_approval"
  | "done"
  | "error";

export type PageLedgerState =
  | "pending"
  | "native_extracted"
  | "ocr_needed"
  | "ocr_running"
  | "ocr_done"
  | "done"
  | "failed_retryable"
  | "failed_permanent"
  | "skipped_no_key";

export type PieceType =
  | "inicial"
  | "contestacao"
  | "replica"
  | "decisao"
  | "sentenca"
  | "recurso"
  | "comprovante"
  | "procuracao"
  | "documento_pessoal"
  | "anexo"
  | "unknown";

export interface PageLedgerEntry {
  case_id: string;
  page: number;
  page_hash?: string;
  state: PageLedgerState;
  text_quality_score?: number;
  text_quality_reasons: string[];
  native_text_chars: number;
  native_text_hash?: string;
  piece_type: PieceType;
  piece_confidence?: number;
  ocr_needed: boolean;
  ocr_attempts: number;
  ocr_last_error_kind?: string;
  ocr_last_error_message?: string;
  /**
   * Rendimento do OCR: "stamp_only" = a transcrição só trouxe os carimbos
   * digitais do PJe (o conteúdo fotografado NÃO foi lido — falso-sucesso);
   * a página fica marcada na cobertura e entra no trilho visual de embeddings.
   */
  ocr_yield?: "content" | "stamp_only";
  /** Versão do prompt de OCR usada; permite re-OCR quando o prompt melhora. */
  ocr_prompt_version?: number;
  evidence_ids: string[];
  updated_at: string;
}

export interface OcrEstimate {
  pages: number;
  calls: number;
  requires_approval: boolean;
  approved: boolean;
  max_pages?: number;
  max_calls?: number;
}

export interface CriticalGap {
  kind:
    | "critical_piece_incomplete"
    | "unknown_unread_potentially_critical"
    | "ingest_incomplete";
  piece_type: PieceType;
  pages: number[];
  reason: string;
}

export interface CoverageManifest {
  case_id: string;
  total_pages: number;
  pages_read: number;
  pages_pending: number[];
  pages_ocr_needed: number[];
  pages_ocr_done: number[];
  pages_failed_retryable: number[];
  pages_failed_permanent: number[];
  /** OCR devolveu só carimbos do PJe: conteúdo da página não transcrito. */
  pages_ocr_stamp_only: number[];
  pages_unknown_unread: number[];
  /** Páginas do PDF que a ingestão NUNCA extraiu (worker morreu antes). */
  pages_never_extracted?: { count: number; intervalo: string };
  ocr_estimate: OcrEstimate;
  critical_gaps: CriticalGap[];
  global_analysis_allowed: boolean;
  warnings: string[];
}

export interface IngestJob {
  job_id: string;
  case_id: string;
  status: IngestJobStatus;
  created_at: string;
  updated_at: string;
  heartbeat_deadline_ms: number;
  lock_owner?: string;
  lock_acquired_at?: string;
  last_heartbeat_at?: string;
  worker_pid?: number;
  alerts: string[];
  ocr_estimate?: OcrEstimate;
  /** Tokens de OCR acumulados (entrada; saída inclui thinking) — custo real BYOK. */
  ocr_tokens_in?: number;
  ocr_tokens_out?: number;
}

export interface CaseStatus {
  case_id: string;
  status: IngestJobStatus;
  total_pages: number;
  processed_pages: number;
  needs_ocr_pages: number[];
  alerts: string[];
  error?: string;
  ocr_tokens?: { entrada: number; saida: number };
}

export type CivilEventType =
  | "citacao"
  | "intimacao"
  | "juntada"
  | "decisao"
  | "sentenca"
  | "contestacao"
  | "replica"
  | "recurso"
  | "manifestacao"
  | "audiencia"
  | "pericia"
  | "pagamento"
  | "negativacao"
  | "outro";

export type DateSource = "texto_do_documento" | "metadado_pje" | "data_juntada" | "inferida";
export type ExtractionSource = "native" | "ocr";

export interface RawCivilEvent {
  raw_event_id: string;
  tipo: CivilEventType;
  subtipo?: string;
  modalidade?: string;
  data_documento?: string;
  data_juntada?: string;
  fonte_data: DateSource;
  descricao: string;
  evidence_ids: string[];
  reading_confidence: number;
  extraction_confidence: number;
  extraction: { source: ExtractionSource; method: "rule" | "rule_and_model" };
}

export interface CivilEvent extends Omit<RawCivilEvent, "raw_event_id" | "extraction"> {
  event_id: string;
  evento_juntada_id?: string;
  canonical_evidence_id: string;
  ambiguities: string[];
  status: "reconciled" | "ambiguous" | "superseded";
}

export type RadarConfidence = "alta" | "media" | "baixa";

export interface RadarItem {
  radar_id: string;
  tipo: "contestacao" | "intempestividade_adversaria" | "prescricao" | "outro";
  status: "conferir";
  lado_favorecido: "autor" | "reu" | "indefinido";
  hipotese: string;
  eventos_base: string[];
  evidence_ids: string[];
  ressalvas?: string[];
  acao_sugerida?: string;
  /** Prazo de referência da tabela local curada (com base legal) — nunca uma data calculada. */
  prazo_referencia?: {
    ato: string;
    prazo: string;
    unidade?: string | null;
    base_legal?: string | null;
    observacoes?: string | null;
    versao_tabela: string;
  };
  reading_confidence: RadarConfidence;
  extraction_confidence: RadarConfidence;
}

export interface CivilProceduralRadar {
  case_id: string;
  generated_at: string;
  coverage: {
    global_analysis_allowed: boolean;
    critical_gaps: number;
  };
  prazos_candidatos: RadarItem[];
  oportunidades: RadarItem[];
  lacunas: string[];
}
