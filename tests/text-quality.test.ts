import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assessTextQuality } from "../src/ocr/text-quality.js";

const fixtures = join(process.cwd(), "tests", "fixtures", "text-quality");

describe("assessTextQuality", () => {
  it("flags short, dense, and gibberish native text for OCR", () => {
    expect(assessTextQuality("Curto").needs_ocr).toBe(true);
    expect(assessTextQuality("PETICAOINICIALAUTORREUVALORDACAUSA").reasons).toContain("low_space_ratio");
    expect(assessTextQuality("\uFFFD\uFFFD\uFFFD\u0000\u0001@@@@@").reasons).toContain("gibberish_ratio_high");
  });

  it("não manda para OCR página de texto bom com URL de assinatura do PJe no rodapé (bug de campo v0.4.0)", () => {
    const corpo =
      "PETIÇÃO INICIAL. O autor, devidamente qualificado nos autos, vem expor e requerer o que segue. ".repeat(
        20,
      );
    const rodape =
      "Assinado eletronicamente por: FULANO DE TAL - 22/06/2026 https://pje.tjce.jus.br:443/pje1grau/Processo/ConsultaDocumento/listView.seam?x=26062220391637300000205535996";
    expect(assessTextQuality(`${corpo}\n${rodape}`).needs_ocr).toBe(false);
  });

  it("continua reprovando página que é só a sequência sem separação", () => {
    expect(
      assessTextQuality(
        "https://pje.tjce.jus.br:443/pje1grau/Processo/ConsultaDocumento/listView.seam?x=26062220391637300000205535996",
      ).needs_ocr,
    ).toBe(true);
  });

  it("reports the expected calibration confusion matrix", () => {
    const cases = [
      ["native_good.txt", false],
      ["native_pje_garbage.txt", true],
      ["scanned_clean.txt", true],
      ["scanned_poor.txt", true],
    ] as const;
    const matrix = { tp: 0, tn: 0, fp: 0, fn: 0 };

    for (const [file, expectedNeedsOcr] of cases) {
      const actual = assessTextQuality(readFileSync(join(fixtures, file), "utf8")).needs_ocr;
      if (actual && expectedNeedsOcr) matrix.tp++;
      if (!actual && !expectedNeedsOcr) matrix.tn++;
      if (actual && !expectedNeedsOcr) matrix.fp++;
      if (!actual && expectedNeedsOcr) matrix.fn++;
    }

    expect(matrix).toEqual({ tp: 3, tn: 1, fp: 0, fn: 0 });
  });
});
