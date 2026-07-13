/**
 * Fold text for rule matching: strip diacritics and lowercase.
 * Real Brazilian legal documents carry accented forms ("citação",
 * "sentença"); all rule patterns are written in folded ASCII and must
 * only ever run against folded text.
 */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}
