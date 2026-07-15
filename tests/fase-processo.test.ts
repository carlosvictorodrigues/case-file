import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { detectarFase } from "../src/civil/fase.js";
import { listarFases, loadFasesPecas } from "../src/civil/fases-pecas.js";
import { faseDoProcesso } from "../src/core/case-service.js";
import { ingestCase } from "../src/ingest/worker.js";
import type { PageLedgerEntry, PieceType } from "../src/domain/types.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "fase-"));
  dirs.push(d);
  return d;
}

function entry(page: number, piece: PieceType): PageLedgerEntry {
  return {
    case_id: "caso",
    page,
    state: "done",
    text_quality_reasons: [],
    native_text_chars: 100,
    piece_type: piece,
    ocr_needed: false,
    ocr_attempts: 0,
    evidence_ids: [],
    updated_at: "2026-07-14T00:00:00.000Z",
  };
}

describe("detector determinístico de fase", () => {
  it("cível: inicial+contestação = defesa; +sentença = decisória; +recurso = recursal", () => {
    const base = [entry(1, "inicial"), entry(10, "contestacao")];
    expect(detectarFase("civil", base).fase_id).toBe("defesa");

    const comSentenca = [...base, entry(50, "sentenca")];
    const decisoria = detectarFase("civil", comSentenca);
    expect(decisoria.fase_id).toBe("decisoria");
    expect(decisoria.ancora?.peca).toBe("sentença");
    expect(decisoria.ancora?.paginas).toContain("50");

    const comRecurso = [...comSentenca, entry(60, "recurso")];
    expect(detectarFase("civil", comRecurso).fase_id).toBe("recursal");
  });

  it("recurso SEM sentença não vira recursal (agravo no meio da instrução)", () => {
    const ledger = [entry(1, "inicial"), entry(10, "contestacao"), entry(20, "recurso")];
    expect(detectarFase("civil", ledger).fase_id).toBe("defesa");
  });

  it("penal: denúncia = ação proposta; +resposta = instrução; +alegações finais = decisória", () => {
    const denuncia = [entry(1, "denuncia")];
    expect(detectarFase("penal", denuncia).fase_id).toBe("acao-proposta");

    const comResposta = [...denuncia, entry(8, "resposta_acusacao")];
    expect(detectarFase("penal", comResposta).fase_id).toBe("instrucao");

    const comAlegacoes = [...comResposta, entry(30, "alegacoes_finais")];
    const decisoria = detectarFase("penal", comAlegacoes);
    expect(decisoria.fase_id).toBe("decisoria");
    expect(decisoria.fase).toContain("sentença pendente");
  });

  it("caderno sem peças processuais = não identificável, sem chute", () => {
    const fase = detectarFase("civil", [entry(1, "anexo"), entry(2, "comprovante")]);
    expect(fase.fase_id).toBe("nao-identificavel");
    expect(fase.observacao).toContain("última");
  });
});

describe("tabela fase → peças", () => {
  it("carrega as fases das duas áreas em ordem", () => {
    const file = loadFasesPecas();
    expect(file.versao).toBeTruthy();
    const civil = listarFases("civil").map((f) => f.fase_id);
    expect(civil[0]).toBe("postulatoria");
    expect(civil).toContain("decisoria");
    expect(listarFases("penal").map((f) => f.fase_id)).toContain("acao-proposta");
  });

  it("toda peça da tabela tem base legal com artigo", () => {
    for (const fase of loadFasesPecas().fases) {
      for (const peca of fase.pecas) {
        expect(peca.base_legal, `${fase.area}/${fase.fase_id}/${peca.peca}`).toMatch(/Art/i);
      }
    }
  });
});

describe("fase_do_processo de ponta a ponta", () => {
  async function makePenalPdf(path: string): Promise<void> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const paginas = [
      "DENUNCIA. O MINISTERIO PUBLICO oferece denuncia em face de JOAO PEREIRA.",
      "RESPOSTA A ACUSACAO do denunciado JOAO PEREIRA.",
    ];
    for (const texto of paginas) {
      const p = pdf.addPage([595, 842]);
      p.drawText(texto.slice(0, 80), { x: 30, y: 400, size: 10, font });
    }
    writeFileSync(path, await pdf.save());
  }

  it("detecta a fase do caso penal e devolve peças da tabela com aviso", async () => {
    const root = tmpRoot();
    const pdf = join(root, "acao.pdf");
    await makePenalPdf(pdf);
    const created = await ingestCase(root, pdf, "caso-fase", { area: "penal" });

    const resultado = faseDoProcesso(root, created.case_id);
    expect(resultado.area).toBe("penal");
    expect(resultado.fase.fase_id).toBe("instrucao");
    expect(resultado.aviso).toContain("nada aqui é ordem de protocolo");
  });

  it("fase_id manual consulta a tabela direto e valida fase inexistente", async () => {
    const root = tmpRoot();
    const pdf = join(root, "acao.pdf");
    await makePenalPdf(pdf);
    const created = await ingestCase(root, pdf, "caso-manual", { area: "penal" });

    const manual = faseDoProcesso(root, created.case_id, "decisoria");
    expect(manual.pecas_cabiveis.length).toBeGreaterThan(0);
    expect(() => faseDoProcesso(root, created.case_id, "fase-inventada")).toThrow(/Válidas/);
  });
});
