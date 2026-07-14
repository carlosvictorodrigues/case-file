import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { consultarPrazos, loadPrazosPenais } from "../src/civil/prazos.js";
import { classifyCivilPiece } from "../src/civil/piece-classifier.js";
import { extractCaseHeaderFacts } from "../src/civil/case-file-facts.js";
import { analyzeCivilRadar } from "../src/core/case-service.js";
import { ingestCase } from "../src/ingest/worker.js";
import type { CaseManifest, EvidenceUnit } from "../src/domain/types.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "area-penal-"));
  dirs.push(d);
  return d;
}

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

describe("tabela de prazos penais (curadoria da planilha do CPP)", () => {
  it("carrega as 36 entradas com escopo e fontes", () => {
    const file = loadPrazosPenais();
    expect(file.prazos).toHaveLength(36);
    expect(file.escopo).toContain("penal");
    expect(file.escopo).toContain("798");
    expect(file.fontes_curadoria.length).toBeGreaterThan(60);
  });

  it("filtra apelação com a base legal literal da curadoria", () => {
    const resultado = consultarPrazos("apelação", "penal");
    expect(resultado.tabela).toBe("penal");
    const apelacao = resultado.prazos.find((p) => p.ato === "Interposição de Apelação");
    expect(apelacao?.prazo).toBe("5 dias");
    expect(apelacao?.base_legal).toBe("Art. 593 do CPP");
    expect(apelacao?.observacoes).toContain("última intimação");
  });

  it("tabela cível continua sendo o default intocado", () => {
    const resultado = consultarPrazos("contestação");
    expect(resultado.tabela).toBe("civel");
    expect(resultado.prazos.some((p) => p.base_legal?.includes("CPC"))).toBe(true);
  });
});

describe("taxonomia de peças penais", () => {
  const classify = (text: string) =>
    classifyCivilPiece({ page: 1, text, textReliable: true }).piece_type;

  it("reconhece denúncia, resposta à acusação, alegações finais e laudo", () => {
    expect(classify("DENÚNCIA que o Ministério Público oferece")).toBe("denuncia");
    expect(classify("RESPOSTA À ACUSAÇÃO do denunciado")).toBe("resposta_acusacao");
    expect(classify("ALEGAÇÕES FINAIS por memoriais")).toBe("alegacoes_finais");
    expect(classify("LAUDO PERICIAL de exame de corpo de delito")).toBe("laudo");
  });

  it("denunciação da lide (cível) NÃO vira denúncia", () => {
    expect(classify("requer a denunciação da lide da seguradora")).not.toBe("denuncia");
  });
});

describe("partes penais", () => {
  it("MP como autor pela combinação MP + denúncia; denunciado como réu", () => {
    const facts = extractCaseHeaderFacts([
      unit(
        1,
        "O MINISTÉRIO PÚBLICO FEDERAL oferece DENÚNCIA em face de JOSÉ CARLOS DA SILVA, pelos crimes...",
      ),
    ]);
    expect(facts.partes.find((p) => p.papel === "autor")?.nome).toBe("MINISTÉRIO PÚBLICO");
    expect(facts.partes.find((p) => p.papel === "reu")?.nome).toBe("JOSÉ CARLOS DA SILVA");
  });

  it("rótulo DENUNCIADO: e corte no rótulo VÍTIMA", () => {
    const facts = extractCaseHeaderFacts([
      unit(1, "DENUNCIADO: PEDRO ALVES MOREIRA VÍTIMA: MARIA JOSÉ"),
    ]);
    expect(facts.partes.find((p) => p.papel === "reu")?.nome).toBe("PEDRO ALVES MOREIRA");
  });
});

describe("caso penal de ponta a ponta", () => {
  async function makePenalPdf(path: string): Promise<void> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const paginas = [
      "DENUNCIA. O MINISTERIO PUBLICO oferece denuncia em face de JOAO PEREIRA, art. 155 do CP.",
      "RESPOSTA A ACUSACAO do denunciado JOAO PEREIRA, requerendo absolvicao sumaria.",
      "SENTENCA. Julgo procedente a denuncia para condenar o reu.",
    ];
    for (const texto of paginas) {
      const p = pdf.addPage([595, 842]);
      p.drawText(texto.slice(0, 90), { x: 30, y: 400, size: 10, font });
    }
    writeFileSync(path, await pdf.save());
  }

  it("criar com area penal grava no manifest e o radar cível recusa com aviso", async () => {
    const root = tmpRoot();
    const pdf = join(root, "acao-penal.pdf");
    await makePenalPdf(pdf);

    const created = await ingestCase(root, pdf, "caso-penal", { area: "penal" });
    const manifest = JSON.parse(
      readFileSync(join(root, created.case_id, "case.json"), "utf8"),
    ) as CaseManifest;
    expect(manifest.area).toBe("penal");

    const radar = await analyzeCivilRadar(root, created.case_id, "reu");
    expect(radar.prazos_candidatos).toEqual([]);
    expect(radar.lacunas.join(" ")).toContain("PENAL");
    expect(radar.lacunas.join(" ")).toContain("tabela='penal'");
  });

  it("caso penal criado como cível ganha alerta sugerindo recriar", async () => {
    const root = tmpRoot();
    const pdf = join(root, "acao-penal.pdf");
    await makePenalPdf(pdf);

    const created = await ingestCase(root, pdf, "caso-penal-civel", {});
    expect(created.status.alerts.join(" ")).toContain("PENAL");
    expect(created.status.alerts.join(" ")).toContain("area='penal'");
  });
});
