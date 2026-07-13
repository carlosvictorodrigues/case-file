import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mapearControversias } from "../src/core/case-service.js";
import { ingestCase } from "../src/ingest/worker.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const F = (num: string, pag: number, data: string) =>
  `Num. ${num} - Pág. ${pag} Assinado eletronicamente por: ANA SILVA - ${data} 10:00:00`;

async function makeContenciosoPdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages: Array<[string, string]> = [
    // Inicial (doc 100): autor alega multa e atraso.
    ["PETIÇÃO INICIAL: o autor alega atraso na entrega e cobra a multa contratual.", F("100", 1, "01/02/2024")],
    // Contestação (doc 200): ré rebate a multa, silencia sobre o atraso.
    ["CONTESTAÇÃO: a ré impugna a multa contratual, que seria indevida e abusiva.", F("200", 1, "10/03/2024")],
    // Contrato (doc 300, fonte primária): cláusula de multa.
    ["CONTRATO firmado entre as partes: cláusula 5ª prevê multa contratual de 10%.", F("300", 1, "15/07/2022")],
  ];
  for (const [body, footer] of pages) {
    const p = pdf.addPage([595, 500]);
    p.drawText(body.slice(0, 95), { x: 20, y: 420, size: 9, font });
    p.drawText(footer, { x: 30, y: 40, size: 7, font });
  }
  writeFileSync(path, await pdf.save());
}

describe("mapear_controversias (P13 fase 4)", () => {
  it("agrupa ocorrências por peça, marca fonte primária e expõe lacunas", async () => {
    const root = mkdtempSync(join(tmpdir(), "controv-"));
    dirs.push(root);
    const pdf = join(root, "processo.pdf");
    await makeContenciosoPdf(pdf);
    await ingestCase(root, pdf, "caso-c");

    const quadro = await mapearControversias(
      root,
      "caso-c",
      [{ nome: "multa contratual" }, { nome: "atraso na entrega" }],
      {},
    );

    // Peças identificadas pelo tipo do mapa do caderno.
    expect(quadro.pecas_identificadas.inicial?.[0].citacao).toBe("ID 100");
    expect(quadro.pecas_identificadas.contestacao?.[0].citacao).toBe("ID 200");

    const multa = quadro.temas.find((t) => t.tema === "multa contratual");
    expect(multa).toBeDefined();
    // Autor alegou, ré rebateu, contrato é fonte primária.
    expect(multa!.inicial[0]?.tipo_fonte).toBe("alegacao_autor");
    expect(multa!.inicial[0]?.citacao).toBe("ID 100, pág. 1");
    expect(multa!.contestacao[0]?.tipo_fonte).toBe("alegacao_reu");
    expect(multa!.fontes_primarias[0]?.tipo_fonte).toBe("prova_primaria");
    expect(multa!.fontes_primarias[0]?.documento?.num).toBe("300");

    // "Atraso": alegado na inicial, SEM ocorrência na contestação → lacuna
    // explícita de impugnação (o servidor não conclui, só aponta).
    const atraso = quadro.temas.find((t) => t.tema === "atraso na entrega");
    expect(atraso!.inicial.length).toBeGreaterThan(0);
    expect(atraso!.contestacao.length).toBe(0);
    expect(atraso!.lacunas.join(" ")).toContain("impugnação específica");

    expect(quadro.aviso_pareamento).toContain("cabem a você");
  });
});
