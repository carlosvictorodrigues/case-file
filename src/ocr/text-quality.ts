export interface TextQualityAssessment {
  score: number;
  needs_ocr: boolean;
  reasons: string[];
}

export type OcrYield = "content" | "stamp_only";

export interface OcrYieldAssessment {
  yield: OcrYield;
  useful_chars_beyond_stamps: number;
}

/**
 * Carimbos digitais que acompanham TODA página do PJe/eproc (assinatura
 * eletrônica, URLs de validação, numeração). Um OCR que devolve SÓ isso não
 * leu o conteúdo da página (foto/manuscrito que o modelo pulou) — não pode
 * contar como página lida (falso-sucesso de campo: caso-2, 37/183 págs).
 * Padrões DELIMITADOS (nunca [^\n]*): o texto nativo de página costuma vir
 * numa linha só, e um padrão até-o-fim-da-linha engoliria conteúdo real.
 */
const STAMP_PATTERNS: RegExp[] = [
  /Num\.\s*\d+\s*-\s*P[áa]g\.\s*\d+/giu,
  // "Assinado eletronicamente por: NOME - dd/mm/yyyy hh:mm:ss" (PJe) e
  // "Documento assinado eletronicamente por NOME, em dd/mm/yyyy, às hh:mm:ss - hash" (TRT).
  /(?:Documento\s+)?[Aa]ssinado eletronicamente por:?\s*.{0,80}?\d{2}\/\d{2}\/\d{4}(?:,?\s*(?:[àa]s\s*)?\d{2}:\d{2}(?::\d{2})?)?(?:\s*-\s*[0-9a-f]{4,12})?/gu,
  /Este documento foi gerado pelo usu[áa]rio\s*[\d.*-]{0,24}(?:\s*em\s*\d{2}\/\d{2}\/\d{4}(?:\s*\d{2}:\d{2}(?::\d{2})?)?)?/giu,
  /N[úu]mero do (?:documento|processo):?\s*[\d.\-]+/giu,
  /https?:\/\/\S+/gu,
  /Fls\.?\s*:?\s*\d+/giu,
];

/** Remove os carimbos digitais do PJe/eproc (para medir/excertar conteúdo). */
export function stripPjeStamps(text: string): string {
  let stripped = text;
  for (const pattern of STAMP_PATTERNS) {
    stripped = stripped.replace(pattern, " ");
  }
  return stripped;
}

const MIN_CONTENT_CHARS_BEYOND_STAMPS = 120;

export function assessOcrYield(text: string): OcrYieldAssessment {
  const stripped = stripPjeStamps(text);
  const sawStamp = stripped !== text;
  const useful = (stripped.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return {
    // Sem carimbo nenhum, texto curto pode ser conteúdo legítimo (página
    // quase em branco com uma anotação) — só reprova quando o que veio é
    // dominado por carimbos.
    yield: sawStamp && useful < MIN_CONTENT_CHARS_BEYOND_STAMPS ? "stamp_only" : "content",
    useful_chars_beyond_stamps: useful,
  };
}

const MIN_USEFUL_CHARS = 20;

export function assessTextQuality(text: string): TextQualityAssessment {
  const normalized = text.replace(/\s+/g, " ").trim();
  const usefulChars = (normalized.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const controlChars = (
    text.match(/\\u(?:FFFD|0000|0001)|[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/gu) ?? []
  ).length;
  const spaces = (normalized.match(/\s/g) ?? []).length;
  const total = Math.max(normalized.length, 1);
  const alnumDensity = usefulChars / total;
  const spaceRatio = spaces / total;
  const longTokens = normalized.split(/\s+/).filter((token) => token.length >= 45);
  const longTokenChars = longTokens.reduce((sum, token) => sum + token.length, 0);
  // Proporção, não existência: TODA página do PJe carrega a URL de verificação
  // da assinatura (90+ chars sem espaço) no rodapé — um único token longo em
  // página de texto bom não pode mandar 1.356 páginas para OCR (bug de campo
  // v0.4.0, processo TJCE). Só reprova quando as sequências sem separação
  // dominam a página ou quase não existe texto além delas.
  const longToken =
    longTokenChars / total > 0.3 || (longTokens.length > 0 && usefulChars < 200);
  const symbolRatio =
    ((normalized.match(/[^\p{L}\p{N}\s.,;:()/%-]/gu) ?? []).length + controlChars) / total;
  const reasons: string[] = [];

  if (usefulChars < MIN_USEFUL_CHARS) reasons.push("too_few_useful_chars");
  if (alnumDensity < 0.45) reasons.push("low_alnum_density");
  if (normalized.length > 20 && spaceRatio < 0.04) reasons.push("low_space_ratio");
  if (longToken) reasons.push("long_unseparated_sequence");
  if (symbolRatio > 0.15 || controlChars >= 2) reasons.push("gibberish_ratio_high");

  const penalty = reasons.length * 0.22;
  const score = Math.max(0, Number((1 - penalty).toFixed(2)));
  return { score, needs_ocr: reasons.length > 0, reasons };
}
