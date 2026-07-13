import { describe, expect, it } from "vitest";
import {
  buildDocumentMap,
  findDocumentForPage,
  parsePjeFooter,
} from "../src/civil/document-map.js";
import type { EvidenceUnit, PageLedgerEntry, PieceType } from "../src/domain/types.js";

function unit(page: number, text: string): EvidenceUnit {
  return {
    evidence_id: `case:caso:page:${page}:unit:p001`,
    case_id: "caso",
    page,
    unit_id: "p001",
    unit_type: "page_text",
    start_offset: 0,
    end_offset: text.length,
    hash: "h",
    text,
  };
}

function ledgerEntry(page: number, piece: PieceType): PageLedgerEntry {
  return {
    case_id: "caso",
    page,
    state: "done",
    text_quality_reasons: [],
    native_text_chars: 100,
    piece_type: piece,
    ocr_needed: false,
    ocr_attempts: 0,
    evidence_ids: [`case:caso:page:${page}:unit:p001`],
    updated_at: "2026-07-08T00:00:00.000Z",
  };
}

const RODAPE_1 =
  "Num. 212240620 - Pág. 1 Assinado eletronicamente por: JOAQUIM VICTOR BEZERRA MAGALHAES - 22/06/2026 20:39:16 https://pje.tjce.jus.br:443/...";
const RODAPE_1B =
  "Num. 212240620 - Pág. 2 Assinado eletronicamente por: JOAQUIM VICTOR BEZERRA MAGALHAES - 22/06/2026 20:39:16";
const RODAPE_2 =
  "Num. 145236848 - Pág. 1 Assinado eletronicamente por: ARIADNE MONTES DUARTE - 15/07/2022 09:20:04";

describe("parsePjeFooter", () => {
  it("extrai Num., página interna, assinante e data ISO do rodapé real", () => {
    expect(parsePjeFooter(`PETIÇÃO INICIAL... ${RODAPE_1}`)).toEqual({
      doc_num: "212240620",
      doc_internal_page: 1,
      signer: "JOAQUIM VICTOR BEZERRA MAGALHAES",
      signed_date: "2026-06-22",
    });
  });

  it("retorna undefined em página sem rodapé PJe", () => {
    expect(parsePjeFooter("Página de contrato escaneada sem rodapé.")).toBeUndefined();
  });
});

describe("buildDocumentMap", () => {
  it("agrupa páginas em documentos com intervalo, data e tipo da primeira página", () => {
    const units = [
      unit(1, `PETIÇÃO INICIAL da autora. ${RODAPE_1}`),
      unit(2, `Continuação dos fatos narrados. ${RODAPE_1B}`),
      unit(3, `CONTRATO DE FRANQUIA celebrado entre as partes. ${RODAPE_2}`),
      unit(4, "Página escaneada sem rodapé."),
    ];
    const ledger = [
      ledgerEntry(1, "inicial"),
      ledgerEntry(2, "unknown"),
      ledgerEntry(3, "unknown"),
      ledgerEntry(4, "unknown"),
    ];

    const map = buildDocumentMap(units, ledger);
    expect(map.total_documentos).toBe(2);
    expect(map.paginas_sem_documento).toEqual([4]);
    expect(map.documentos[0]).toMatchObject({
      num: "212240620",
      first_page: 1,
      last_page: 2,
      pages: 2,
      signed_date: "2026-06-22",
      piece_type: "inicial", // primeira página decide; continuações herdam
    });
    expect(map.documentos[1]).toMatchObject({
      num: "145236848",
      signed_date: "2022-07-15",
      signer: "ARIADNE MONTES DUARTE",
    });

    expect(findDocumentForPage(map, 2)?.num).toBe("212240620");
    expect(findDocumentForPage(map, 3)?.num).toBe("145236848");
    expect(findDocumentForPage(map, 4)).toBeUndefined();
  });
});
