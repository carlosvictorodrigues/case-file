export interface CaseFileConfig {
  casesDir: string;
  geminiApiKey?: string;
  ocrModel?: string;
  embeddingModel?: string;
  ocrMaxConcurrency?: number;
  ocrMaxRetryAttempts?: number;
  ocrApprovalPageThreshold?: number;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed.length ? trimmed : undefined;
}

function optionalNumber(value: string | undefined, fallback: number): number {
  const raw = optional(value);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  // Valor inválido não pode desligar um gate de custo em silêncio.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * v1.0: variáveis oficiais CASE_FILE_*; os nomes legados JUSRATIO_* seguem
 * aceitos como fallback para não quebrar instalação existente (manifests
 * antigos injetam os nomes velhos).
 */
function legacy(env: NodeJS.ProcessEnv, name: string, legacyName: string): string | undefined {
  return optional(env[name]) ?? optional(env[legacyName]);
}

export function loadConfig(env: NodeJS.ProcessEnv): CaseFileConfig {
  const casesDir = legacy(env, "CASE_FILE_CASES_DIR", "JUSRATIO_CASES_DIR");
  if (!casesDir) {
    throw new Error("CASE_FILE_CASES_DIR is required");
  }
  return {
    casesDir,
    geminiApiKey: optional(env.GEMINI_API_KEY),
    ocrModel: optional(env.GEMINI_OCR_MODEL) ?? "gemini-3.5-flash",
    embeddingModel: optional(env.GEMINI_EMBEDDING_MODEL) ?? "gemini-embedding-2",
    ocrMaxConcurrency: optionalNumber(
      legacy(env, "CASE_FILE_OCR_MAX_CONCURRENCY", "JUSRATIO_OCR_MAX_CONCURRENCY"),
      2,
    ),
    ocrMaxRetryAttempts: optionalNumber(
      legacy(env, "CASE_FILE_OCR_MAX_RETRY_ATTEMPTS", "JUSRATIO_OCR_MAX_RETRY_ATTEMPTS"),
      3,
    ),
    ocrApprovalPageThreshold: optionalNumber(
      legacy(env, "CASE_FILE_OCR_APPROVAL_PAGE_THRESHOLD", "JUSRATIO_OCR_APPROVAL_PAGE_THRESHOLD"),
      25,
    ),
  };
}
