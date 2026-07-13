import { existsSync, readFileSync } from "node:fs";
import { evidenceId, sha256 } from "../domain/evidence.js";
import type { EvidenceUnit, PageLedgerState } from "../domain/types.js";
import { GoogleGeminiOcrClient, type GeminiOcrClient } from "./gemini-client.js";

export interface RunOcrForPageInput {
  caseId: string;
  page: number;
  pageText: string;
  pageTextPath: string;
  pageImagePath?: string;
  pagePdfPath?: string;
  inputBytes?: Uint8Array;
  mimeType?: "image/png" | "application/pdf";
  geminiApiKey?: string;
  model?: string;
  client?: GeminiOcrClient;
}

export interface OcrPageResult {
  state: PageLedgerState;
  evidence?: EvidenceUnit;
  error_kind?: "timeout" | "rate_limit" | "server_error" | "invalid_response" | "no_text_detected";
  error_message?: string;
  /** Tokens reais da chamada (mesmo em falha — a API cobrou igual). */
  tokens?: { entrada: number; saida: number };
}

const DEFAULT_MODEL = "gemini-3.5-flash";
const OCR_WARNING = "transcricao por OCR, conferir no original";

export async function runOcrForPage(input: RunOcrForPageInput): Promise<OcrPageResult> {
  if (!input.geminiApiKey) {
    return { state: "skipped_no_key", evidence: undefined };
  }

  const ocrInput = readOcrInput(input);
  if (!ocrInput) {
    return {
      state: "failed_retryable",
      error_kind: "invalid_response",
      error_message: "missing OCR input artifact",
    };
  }

  const client = input.client ?? new GoogleGeminiOcrClient();
  const transcription = await client.transcribePage({
    imageBytes: ocrInput.bytes,
    mimeType: ocrInput.mimeType,
    apiKey: input.geminiApiKey,
    model: input.model ?? DEFAULT_MODEL,
  });
  const text = transcription.text.trim();
  if (!text) {
    return {
      state: "failed_retryable",
      error_kind: "invalid_response",
      error_message: "empty OCR transcription",
      tokens: transcription.tokens,
    };
  }

  const sourcePath = input.pageTextPath.replace(/\.txt$/i, ".ocr.txt");
  const evidence: EvidenceUnit = {
    evidence_id: evidenceId(input.caseId, input.page, "ocr001"),
    case_id: input.caseId,
    page: input.page,
    unit_id: "ocr001",
    unit_type: "ocr_paragraph",
    start_offset: 0,
    end_offset: text.length,
    hash: sha256(text),
    source_path: sourcePath,
    text,
    image_ref: {
      page_image_path: input.pageImagePath,
      page_pdf_path: input.pagePdfPath,
      bbox: transcription.bbox,
    },
    ocr: {
      provider: "google",
      model: input.model ?? DEFAULT_MODEL,
      reading_confidence: transcription.reading_confidence,
      warning: OCR_WARNING,
    },
  };

  return { state: "ocr_done", evidence, tokens: transcription.tokens };
}

function readOcrInput(
  input: RunOcrForPageInput,
): { bytes: Uint8Array; mimeType: "image/png" | "application/pdf" } | undefined {
  if (input.inputBytes && input.mimeType) {
    return { bytes: input.inputBytes, mimeType: input.mimeType };
  }
  if (input.pagePdfPath && existsSync(input.pagePdfPath)) {
    return { bytes: readFileSync(input.pagePdfPath), mimeType: "application/pdf" };
  }
  if (input.pageImagePath && existsSync(input.pageImagePath)) {
    return { bytes: readFileSync(input.pageImagePath), mimeType: "image/png" };
  }
  return undefined;
}
