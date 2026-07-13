import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  analyzeCivilRadar,
  buildEvidenceBundle,
  getCaseFile,
  getStatus,
  openEvidence,
  searchCase,
  consultarLinhaDoTempo,
} from "../src/core/case-service.js";
import { verifyReferences } from "../src/core/verifier.js";
import { ingestCase } from "../src/ingest/worker.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

// Texto ACENTUADO de propósito: é assim que processos reais chegam do PJe.
const PAGES = [
  "PETIÇÃO INICIAL. O autor JOÃO DA SILVA, brasileiro, ajuizou ação de cobrança em face de EMPRESA XYZ LTDA. Valor da causa: R$ 52.340,18. O contrato previa multa de 2% e juros de mora de 1% ao mês. Requer a condenação da ré ao pagamento integral.",
  "CERTIDÃO. Certifico que a citação do réu foi realizada em 10/05/2024, por oficial de justiça, conforme mandado anexo. O prazo para contestação flui a partir da juntada do mandado em 15/05/2024.",
  "SENTENÇA. Julgo procedente o pedido para condenar a ré ao pagamento de R$ 52.340,18, corrigidos monetariamente. Publicada em 20/06/2024. Intimação das partes pelo DJE em 25/06/2024.",
  "COMPROVANTE de transferência PIX no valor de R$ 52.340,18, recibo emitido em favor do credor.",
];

async function makeAccentedPdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of PAGES) {
    const page = pdf.addPage([595, 842]);
    const words = text.split(" ");
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      if ((line + " " + word).length > 70) {
        lines.push(line);
        line = word;
      } else {
        line = line ? line + " " + word : word;
      }
    }
    lines.push(line);
    let y = 800;
    for (const l of lines) {
      page.drawText(l, { x: 40, y, size: 12, font });
      y -= 18;
    }
  }
  writeFileSync(path, await pdf.save());
}

describe("E2E: caso cível com texto acentuado real", () => {
  it("ingere, busca com e sem acento, gera radar e verifica referências", async () => {
    const root = mkdtempSync(join(tmpdir(), "e2e-civil-"));
    dirs.push(root);
    const pdf = join(root, "processo.pdf");
    await makeAccentedPdf(pdf);

    const created = await ingestCase(root, pdf, "caso-e2e");
    expect(created.status.status).toBe("done");
    expect(getStatus(root, "caso-e2e").total_pages).toBe(4);

    // FTS5 unicode61 é accent-insensitive: as duas grafias acham a certidão.
    for (const query of ["citação", "citacao", "oficial de justiça"]) {
      const hits = await searchCase(root, "caso-e2e", query, 5);
      expect(hits.map((h) => h.page)).toContain(2);
      // A busca devolve trecho, nunca a página inteira.
      expect(hits[0].text).toBeUndefined();
      expect(hits[0].snippet).toBeTruthy();
    }

    // Consulta em linguagem natural não pode retornar vazio (fallback OR).
    const natural = await searchCase(root, "caso-e2e", "quando o réu foi citado", 5);
    expect(natural.length).toBeGreaterThan(0);
    expect(natural[0].page).toBe(2);
    const valor = await searchCase(root, "caso-e2e", "valor da causa", 5);
    expect(valor.map((h) => h.page)).toContain(1);
    const montante = await searchCase(root, "caso-e2e", "R$ 52.340,18", 5);
    expect(montante.map((h) => h.page).sort()).toEqual([1, 3, 4]);

    // O cenário-alvo do produto: certidão de citação → radar de contestação.
    const radar = await analyzeCivilRadar(root, "caso-e2e", "reu");
    expect(radar.prazos_candidatos).toHaveLength(1);
    expect(radar.oportunidades).toHaveLength(1);
    expect(radar.prazos_candidatos[0].tipo).toBe("contestacao");
    expect(radar.prazos_candidatos[0].prazo_referencia?.prazo).toBe("15 dias");
    expect(radar.prazos_candidatos[0].prazo_referencia?.base_legal).toContain("335");

    // P14: cronologia mora SO na linha_do_tempo; o case_file e painel.
    const cronologia = consultarLinhaDoTempo(root, "caso-e2e");
    const eventosDatados = cronologia.entradas.filter((e) => e.origem === "evento");
    // Citação (p. 2) vira evento datado; a p. 3 também gera evento (o
    // extractor emite um evento por página — intimação/sentença).
    const tipos = eventosDatados.map((evento) => evento.tipo.split("/")[0]);
    expect(tipos).toContain("citacao");
    expect(eventosDatados.length).toBeGreaterThanOrEqual(2);
    const citacao = eventosDatados.find((evento) => evento.tipo.startsWith("citacao"));
    expect(citacao?.data).toBe("2024-05-10");

    // Proveniência fecha o ciclo: evidence_id do radar reabre o verbatim.
    const evidenceId = radar.prazos_candidatos[0].evidence_ids[0];
    const evidence = await openEvidence(root, "caso-e2e", evidenceId);
    expect(evidence.text).toContain("citação");
    expect(evidence.page).toBe(2);

    const verified = await verifyReferences(root, "caso-e2e", {
      evidence_ids: [evidenceId],
      doc_ids: [],
    });
    expect(verified.ok).toBe(true);

    // P2a: o case_file compacto agora carrega fatos reais com proveniência.
    const enrichedCaseFile = getCaseFile(root, "caso-e2e") as {
      resumo: string;
      partes: Array<{ papel: string; nome: string; evidence_id: string }>;
      valor_causa?: { valor: string; evidence_id: string };
    };
    expect(enrichedCaseFile.partes.find((p) => p.papel === "autor")?.nome).toBe("JOÃO DA SILVA");
    expect(enrichedCaseFile.partes.find((p) => p.papel === "reu")?.nome).toContain("EMPRESA XYZ");
    expect(enrichedCaseFile.valor_causa?.valor).toBe("R$ 52.340,18");
    expect(enrichedCaseFile.resumo).toContain("citação em 2024-05-10");
    expect(enrichedCaseFile.resumo).toContain("Valor da causa");

    // P2b: bundle dirigido pelo objetivo, com teses do radar, provas
    // classificadas e query de jurisprudência SEM dados pessoais.
    const bundle = await buildEvidenceBundle(
      root,
      "caso-e2e",
      "multa contratual e juros de mora",
      "reu",
      10,
    );
    expect(bundle.fatos_relevantes.length).toBeGreaterThan(0);
    expect(bundle.teses_sugeridas.length).toBeGreaterThan(0);
    expect(bundle.provas).toHaveLength(1);
    expect(bundle.provas[0]).toMatchObject({ tipo: "comprovante", page: 4 });
    const query = bundle.queries_jurisprudencia[0].query;
    expect(query).toContain("multa contratual");
    expect(query.toUpperCase()).not.toContain("JOÃO");
    expect(query.toUpperCase()).not.toContain("SILVA");
    expect(query.toUpperCase()).not.toContain("XYZ");
  });
});
