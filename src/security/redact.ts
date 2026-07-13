const GOOGLE_API_KEY_RE = /AIza[0-9A-Za-z_-]{20,}/g;
const KEY_QUERY_PARAM_RE = /([?&]key=)[^&\s"']+/gi;

/**
 * Remove segredos de mensagens de erro antes de persistir/exibir.
 * Alerts de job vão para status.json/SQLite e voltam para o LLM via
 * status_caso — nenhum valor de chave pode sobreviver a esse caminho.
 */
export function redactSecrets(message: string, knownSecrets: Array<string | undefined> = []): string {
  let out = message
    .replace(GOOGLE_API_KEY_RE, "[REDACTED]")
    .replace(KEY_QUERY_PARAM_RE, "$1[REDACTED]");
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 8) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return out;
}
