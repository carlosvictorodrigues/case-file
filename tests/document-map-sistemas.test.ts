import { describe, expect, it } from "vitest";
import {
  buildDocumentMap,
  citeDocument,
  findDocumentForPage,
  findFolhaEstj,
  parseEstjFolha,
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
    updated_at: "2026-07-13T00:00:00.000Z",
  };
}

const RODAPE_PJE = "Num. 212240620 - Pág. 1";

describe("detecção do sistema de origem", () => {
  it("caderno com rodapé PJe continua saindo como pje (byte-idêntico)", () => {
    const map = buildDocumentMap(
      [unit(1, `PETIÇÃO INICIAL ${RODAPE_PJE}`)],
      [ledgerEntry(1, "inicial")],
    );
    expect(map.sistema).toBe("pje");
    expect(map.total_documentos).toBe(1);
    expect(citeDocument(map.documentos[0])).toBe("ID 212240620");
  });

  it("sem nenhum carimbo reconhecido, sistema é desconhecido e nada é inventado", () => {
    const map = buildDocumentMap(
      [unit(1, "Contrato escaneado."), unit(2, "Outra página qualquer.")],
      [ledgerEntry(1, "anexo"), ledgerEntry(2, "anexo")],
    );
    expect(map.sistema).toBe("desconhecido");
    expect(map.total_documentos).toBe(0);
    expect(map.paginas_sem_documento).toEqual([1, 2]);
  });
});

describe("e-STJ: folha carimbada por página", () => {
  it("parseEstjFolha lê o carimbo real de folha", () => {
    expect(parseEstjFolha("RECURSO ESPECIAL Nº 1.234.567 e-STJ Fl.2041")).toBe(2041);
    expect(parseEstjFolha("texto sem carimbo")).toBeUndefined();
  });

  it("caderno do e-STJ vira sistema estj com folha citável por página", () => {
    const map = buildDocumentMap(
      [
        unit(1, "Petição de recurso e-STJ Fl.1500"),
        unit(2, "continuação e-STJ Fl.1501"),
        unit(3, "decisão agravada e-STJ Fl.1502"),
        unit(4, "página escaneada sem carimbo"),
      ],
      [1, 2, 3, 4].map((page) => ledgerEntry(page, "unknown")),
    );
    expect(map.sistema).toBe("estj");
    expect(map.total_documentos).toBe(0);
    expect(findFolhaEstj(map, 2)).toBe(1501);
    expect(findFolhaEstj(map, 4)).toBeUndefined();
    expect(map.paginas_sem_documento).toEqual([4]);
  });

  it("uma menção avulsa a e-STJ não rotula o caderno (cobertura mínima)", () => {
    const map = buildDocumentMap(
      [
        unit(1, "a decisão de e-STJ Fl.99 citada na peça"),
        ...Array.from({ length: 9 }, (_, i) => unit(i + 2, `página comum ${i}`)),
      ],
      Array.from({ length: 10 }, (_, i) => ledgerEntry(i + 1, "unknown")),
    );
    expect(map.sistema).toBe("desconhecido");
  });
});

describe("eproc: evento + rótulo do documento", () => {
  const paginasEproc = [
    unit(1, "PETIÇÃO INICIAL ... Evento 1 - INIC1"),
    unit(2, "continuação da inicial Evento 1 - INIC1"),
    unit(3, "CONTESTAÇÃO ... Evento 14 - CONT1"),
    unit(4, "SENTENÇA ... Evento 32 - SENT1"),
  ];

  it("lê a página interna carimbada no cabeçalho da íntegra (formato validado)", () => {
    const map = buildDocumentMap(
      [
        unit(1, "5001234-56.2023.4.04.7000 / Evento 1 - INIC1 / Página 1"),
        unit(2, "5001234-56.2023.4.04.7000 / Evento 1 - INIC1 / Página 2"),
        unit(3, "5001234-56.2023.4.04.7000 / Evento 14 - CONT1 / Página 1"),
      ],
      [ledgerEntry(1, "inicial"), ledgerEntry(2, "inicial"), ledgerEntry(3, "contestacao")],
    );
    expect(map.sistema).toBe("eproc");
    expect(map.paginas_internas_eproc?.["2"]).toBe(2);
    expect(map.paginas_internas_eproc?.["3"]).toBe(1);
  });

  it("agrupa páginas por (evento, rótulo) e cita no padrão do gabinete", () => {
    const map = buildDocumentMap(paginasEproc, [
      ledgerEntry(1, "inicial"),
      ledgerEntry(2, "inicial"),
      ledgerEntry(3, "contestacao"),
      ledgerEntry(4, "sentenca"),
    ]);
    expect(map.sistema).toBe("eproc");
    expect(map.total_documentos).toBe(3);
    const inicial = findDocumentForPage(map, 2);
    expect(inicial?.evento).toBe("1");
    expect(inicial?.rotulo).toBe("INIC1");
    expect(citeDocument(inicial!)).toBe("Evento 1, INIC1");
    expect(citeDocument(findDocumentForPage(map, 4)!)).toBe("Evento 32, SENT1");
  });

  it("PJe tem precedência: rodapé PJe presente vence menções a evento", () => {
    const map = buildDocumentMap(
      [unit(1, `peça citando o Evento 3 - PET1 do outro feito ${RODAPE_PJE}`)],
      [ledgerEntry(1, "inicial")],
    );
    expect(map.sistema).toBe("pje");
  });

  it("menção avulsa a evento no meio de peça não rotula o caderno", () => {
    const map = buildDocumentMap(
      [
        unit(1, "conforme decidido no Evento 12 - PET1 daquele processo"),
        ...Array.from({ length: 9 }, (_, i) => unit(i + 2, `página comum ${i}`)),
      ],
      Array.from({ length: 10 }, (_, i) => ledgerEntry(i + 1, "unknown")),
    );
    expect(map.sistema).toBe("desconhecido");
  });
});
