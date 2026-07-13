import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { consultarMapaCaderno, openPage, searchCaseHybrid } from "../src/core/case-service.js";
import { ingestCase } from "../src/ingest/worker.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const FOOTER_1 = "Num. 111 - Pág. 1 Assinado eletronicamente por: ANA SILVA - 01/02/2024 10:00:00";
const FOOTER_2 = "Num. 222 - Pág. 1 Assinado eletronicamente por: JOSE LIMA - 15/07/2022 09:00:00";
const FOOTER_2B = "Num. 222 - Pág. 2 Assinado eletronicamente por: JOSE LIMA - 15/07/2022 09:00:00";

async function makePjePdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages: Array<[string, string]> = [
    ["PETIÇÃO INICIAL: o autor requer a condenação da ré ao pagamento.", FOOTER_1],
    ["CONTRATO DE FRANQUIA celebrado entre as partes prevê o pagamento.", FOOTER_2],
    ["Continuação do contrato com as obrigações das partes contratantes.", FOOTER_2B],
  ];
  for (const [body, footer] of pages) {
    const p = pdf.addPage([595, 500]);
    p.drawText(body.slice(0, 90), { x: 30, y: 420, size: 10, font });
    p.drawText(footer, { x: 30, y: 40, size: 7, font });
  }
  writeFileSync(path, await pdf.save());
}

describe("mapa do caderno na ingestão + anotação de documento nos hits", () => {
  it("gera mapa_caderno.json, anota buscar_no_processo e responde mapa_do_caderno", async () => {
    const root = mkdtempSync(join(tmpdir(), "docmap-e2e-"));
    dirs.push(root);
    const pdf = join(root, "processo.pdf");
    await makePjePdf(pdf);
    await ingestCase(root, pdf, "caso-map");

    expect(existsSync(join(root, "caso-map", "artifacts", "mapa_caderno.json"))).toBe(true);

    // Default "principais": a inicial (peça processual) detalhada; o doc 222
    // (2 págs < min_paginas) vai para os GRUPOS — anti-bomba-de-contexto.
    const mapa = consultarMapaCaderno(root, "caso-map");
    expect(mapa.modo).toBe("principais");
    expect(mapa.total_documentos).toBe(2);
    expect(mapa.documentos.map((d) => d.num)).toEqual(["111"]);
    expect(mapa.has_more).toBe(true);
    expect(mapa.grupos?.[0]).toMatchObject({ count: 1 });
    expect(mapa.grupos?.[0].exemplos[0].num).toBe("222");

    // modo completo lista tudo, com citação por documento.
    const completo = consultarMapaCaderno(root, "caso-map", { modo: "completo" });
    expect(completo.documentos.map((d) => d.num)).toEqual(["111", "222"]);
    expect(completo.documentos[0].signed_date).toBe("2024-02-01");
    expect(completo.documentos[1].signed_date).toBe("2022-07-15");
    expect(completo.documentos[1].citacao).toBe("ID 222");

    // Filtro por tipo (assinatura antiga, string) devolve só aquele tipo.
    const tipo = mapa.documentos[0].piece_type;
    const filtrado = consultarMapaCaderno(root, "caso-map", tipo);
    expect(filtrado.documentos.every((d) => d.piece_type === tipo)).toBe(true);

    // Hit da busca vem anotado com o documento de origem (fonte primária vs menção)
    // e com a CITAÇÃO FORENSE pronta (ID + página interna do documento).
    const { results } = await searchCaseHybrid(root, "caso-map", "pagamento", 5, {});
    expect(results.length).toBeGreaterThan(0);
    for (const hit of results) {
      expect(hit.documento?.num).toBe(hit.page === 1 ? "111" : "222");
      expect(hit.documento?.data_juntada).toBeTruthy();
      expect(hit.documento?.pag_no_documento).toBe(hit.page === 1 ? 1 : 1);
      expect(hit.documento?.citacao).toBe(
        hit.page === 1 ? "ID 111, pág. 1" : "ID 222, pág. 1",
      );
    }
    // Continuação do doc 222 (pág. global 3 = pág. INTERNA 2 do documento):
    // é a página interna que vale como citação forense.
    const pagina3 = await openPage(root, "caso-map", 3);
    expect(pagina3.documento?.citacao).toBe("ID 222, pág. 2");
    expect(pagina3.documento?.pag_no_documento).toBe(2);
  });

  it("caso sem rodapé PJe: mapa vazio e hits sem anotação, sem quebrar", async () => {
    const root = mkdtempSync(join(tmpdir(), "docmap-none-"));
    dirs.push(root);
    const pdf = join(root, "processo.pdf");
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([595, 500]);
    p.drawText("CERTIDÃO simples sem rodapé de assinatura eletrônica.", { x: 30, y: 420, size: 10, font });
    writeFileSync(pdf, await doc.save());
    await ingestCase(root, pdf, "caso-plain");

    const mapa = consultarMapaCaderno(root, "caso-plain");
    expect(mapa.total_documentos).toBe(0);
    expect(mapa.paginas_sem_documento).toBe(1);

    const { results } = await searchCaseHybrid(root, "caso-plain", "certidão", 5, {});
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].documento).toBeUndefined();
  });
});
