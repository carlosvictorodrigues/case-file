import { describe, expect, it } from "vitest";
import {
  buildStructuralSummary,
  detectLegalConcepts,
  extractCaseHeaderFacts,
} from "../src/civil/case-file-facts.js";
import { stripPersonalData } from "../src/security/pii.js";
import type { EvidenceUnit } from "../src/domain/types.js";

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

describe("extractCaseHeaderFacts", () => {
  it("extrai autor por qualificação, réu por 'em face de' e valor da causa", () => {
    const facts = extractCaseHeaderFacts([
      unit(
        1,
        "PETIÇÃO INICIAL. JOÃO DA SILVA, brasileiro, casado, ajuizou ação de cobrança em face de EMPRESA XYZ LTDA. Valor da causa: R$ 52.340,18.",
      ),
    ]);
    const autor = facts.partes.find((parte) => parte.papel === "autor");
    const reu = facts.partes.find((parte) => parte.papel === "reu");
    expect(autor?.nome).toBe("JOÃO DA SILVA");
    expect(autor?.evidence_id).toBe("case:caso:page:1:unit:p001");
    expect(reu?.nome).toBe("EMPRESA XYZ LTDA");
    expect(facts.valor_causa?.valor).toBe("R$ 52.340,18");
  });

  it("prioriza labels explícitos sobre heurísticas", () => {
    const facts = extractCaseHeaderFacts([
      unit(1, "REQUERENTE: MARIA OLIVEIRA\nREQUERIDO: BANCO ALFA S.A.\nMARIA OLIVEIRA, brasileira, vem expor."),
    ]);
    expect(facts.partes.find((p) => p.papel === "autor")).toMatchObject({
      nome: "MARIA OLIVEIRA",
      confianca: 0.9,
    });
    expect(facts.partes.find((p) => p.papel === "reu")).toMatchObject({
      nome: "BANCO ALFA S.A",
      confianca: 0.9,
    });
  });

  it("corta o nome no rótulo seguinte quando o cabeçalho vem numa linha só (campo TJRJ)", () => {
    const facts = extractCaseHeaderFacts([
      unit(
        1,
        "MANDADO DE SEGURANÇA IMPETRANTE: GABRIEL ALMEIDA COSTA IMPETRADO : SECRETÁRIO DE ESTADO DE EDUCAÇÃO ADVOGADO: JEFFERSON GOMES",
      ),
    ]);
    expect(facts.partes.find((p) => p.papel === "autor")?.nome).toBe("GABRIEL ALMEIDA COSTA");
    expect(facts.partes.find((p) => p.papel === "reu")?.nome).toBe(
      "SECRETÁRIO DE ESTADO DE EDUCAÇÃO",
    );
  });

  it("não cola o título da seção seguinte no nome do réu", () => {
    const facts = extractCaseHeaderFacts([
      unit(1, "REQUERIDO: PORTOBELLO SHOP S/A DESPACHO Vistos etc."),
    ]);
    expect(facts.partes.find((p) => p.papel === "reu")?.nome).toBe("PORTOBELLO SHOP S/A");
  });

  it("sem padrões reconhecíveis não inventa partes", () => {
    const facts = extractCaseHeaderFacts([unit(1, "Despacho de mero expediente sem partes nomeadas.")]);
    expect(facts.partes).toEqual([]);
    expect(facts.valor_causa).toBeUndefined();
  });
});

describe("buildStructuralSummary + detectLegalConcepts", () => {
  it("monta resumo estrutural rastreável", () => {
    const facts = extractCaseHeaderFacts([
      unit(1, "JOÃO DA SILVA, brasileiro, ajuizou cobrança em face de EMPRESA XYZ LTDA. Valor da causa: R$ 100,00."),
    ]);
    const resumo = buildStructuralSummary({
      totalPages: 3,
      facts,
      ledger: [],
      events: [],
    });
    expect(resumo).toContain("3 página(s)");
    expect(resumo).toContain("JOÃO DA SILVA");
    expect(resumo).toContain("R$ 100,00");
  });

  it("detecta conceitos jurídicos em texto acentuado", () => {
    const concepts = detectLegalConcepts([
      "comprovante de pagamento da fatura",
      "preliminar de prescrição e dano moral",
    ]);
    expect(concepts).toContain("pagamento");
    expect(concepts).toContain("prescricao");
    expect(concepts).toContain("dano moral");
  });
});

describe("stripPersonalData", () => {
  it("remove nomes das partes, CPF, CNPJ, número CNJ e e-mail", () => {
    const out = stripPersonalData(
      "cobrança de JOÃO DA SILVA (CPF 123.456.789-01, joao@exemplo.com.br) contra EMPRESA XYZ LTDA CNPJ 12.345.678/0001-99 no processo 1234567-89.2024.8.26.0100 sobre joao da silva",
      ["JOÃO DA SILVA", "EMPRESA XYZ LTDA"],
    );
    expect(out).not.toContain("JOÃO");
    expect(out).not.toContain("joao da silva");
    expect(out).not.toContain("123.456.789-01");
    expect(out).not.toContain("12.345.678/0001-99");
    expect(out).not.toContain("1234567-89");
    expect(out).not.toContain("@exemplo");
    expect(out).toContain("cobrança");
    expect(out).toContain("[parte]");
  });
});
