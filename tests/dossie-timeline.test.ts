import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { consultarLinhaDoTempo, getCaseFile, searchCaseHybrid } from "../src/core/case-service.js";
import { lerDossie, registrarAchado } from "../src/core/dossie.js";
import { ingestCase } from "../src/ingest/worker.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const RODAPE_1 = "Num. 111 - Pág. 1 Assinado eletronicamente por: ANA SILVA - 01/02/2024 10:00:00";
const RODAPE_2 = "Num. 222 - Pág. 1 Assinado eletronicamente por: JOSE LIMA - 15/07/2022 09:00:00";

async function makeCase(root: string, caseId: string): Promise<void> {
  const pdf = join(root, "processo.pdf");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages: Array<[string, string]> = [
    ["PETIÇÃO INICIAL: o autor requer a condenação da ré ao pagamento.", RODAPE_1],
    ["CONTRATO DE FRANQUIA celebrado entre as partes prevê o pagamento.", RODAPE_2],
  ];
  for (const [body, footer] of pages) {
    const p = doc.addPage([595, 500]);
    p.drawText(body.slice(0, 90), { x: 30, y: 420, size: 10, font });
    p.drawText(footer, { x: 30, y: 40, size: 7, font });
  }
  writeFileSync(pdf, await doc.save());
  await ingestCase(root, pdf, caseId);
}

describe("dossiê persistente", () => {
  it("registra achado com lastro validado, é idempotente e sobrevive fora da conversa", async () => {
    const root = mkdtempSync(join(tmpdir(), "dossie-"));
    dirs.push(root);
    await makeCase(root, "caso-d");

    const { results } = await searchCaseHybrid(root, "caso-d", "contrato de franquia", 5, {});
    const evidenceId = results[0].evidence_id;

    const primeiro = await registrarAchado(
      root,
      "caso-d",
      "Contrato de franquia localizado na pág. 2, juntado em 15/07/2022.",
      [evidenceId],
    );
    expect(primeiro.total).toBe(1);

    // Idempotente: o mesmo achado não duplica.
    const repetido = await registrarAchado(
      root,
      "caso-d",
      "Contrato de franquia localizado na pág. 2, juntado em 15/07/2022.",
      [evidenceId],
    );
    expect(repetido.achado_id).toBe(primeiro.achado_id);
    expect(repetido.total).toBe(1);

    // O dossiê restaura o estado da investigação — é leitura pura de disco,
    // independe de qualquer histórico de conversa.
    const dossie = lerDossie(root, "caso-d");
    expect(dossie.total).toBe(1);
    expect(dossie.achados[0].achado).toContain("Contrato de franquia");
    expect(dossie.achados[0].evidence_ids).toEqual([evidenceId]);
  });

  it("recusa achado sem lastro ou com evidence_id inexistente", async () => {
    const root = mkdtempSync(join(tmpdir(), "dossie-neg-"));
    dirs.push(root);
    await makeCase(root, "caso-neg");

    await expect(registrarAchado(root, "caso-neg", "Fato sem lastro.", [])).rejects.toThrow(
      /sem lastro/,
    );
    await expect(
      registrarAchado(root, "caso-neg", "Fato inventado.", ["case:caso-neg:page:99:unit:p001"]),
    ).rejects.toThrow(/desconhecido/);
    expect(lerDossie(root, "caso-neg").total).toBe(0);
  });
});

describe("linha do tempo determinística", () => {
  it("combina juntadas do mapa (datadas) ordenadas, com filtro de período", async () => {
    const root = mkdtempSync(join(tmpdir(), "timeline-"));
    dirs.push(root);
    await makeCase(root, "caso-t");

    const tudo = consultarLinhaDoTempo(root, "caso-t");
    const juntadas = tudo.entradas.filter((e) => e.origem === "juntada");
    expect(juntadas.length).toBe(2);
    // Ordenada por data: o contrato (2022) vem antes da inicial (2024).
    expect(juntadas[0].data).toBe("2022-07-15");
    expect(juntadas[0].documento?.num).toBe("222");
    expect(juntadas[1].data).toBe("2024-02-01");

    const periodo = consultarLinhaDoTempo(root, "caso-t", { de: "2024-01-01" });
    expect(periodo.entradas.every((e) => (e.data ?? "") >= "2024-01-01")).toBe(true);
    expect(periodo.entradas.some((e) => e.documento?.num === "111")).toBe(true);
    expect(periodo.entradas.some((e) => e.documento?.num === "222")).toBe(false);
  });
});

describe("case_file com dieta de contexto", () => {
  it("eventos datados viram 1 linha com evidence_id, sem descrição crua", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-dieta-"));
    dirs.push(root);
    await makeCase(root, "caso-cf");

    const caseFile = getCaseFile(root, "caso-cf") as Record<string, unknown>;
    const eventos = (caseFile.eventos_datados ?? []) as Array<Record<string, unknown>>;
    for (const evento of eventos) {
      expect(evento.evidence_id).toBeTruthy();
      expect(evento.descricao).toBeUndefined();
      const resumo = String(evento.resumo ?? "");
      expect(resumo.length).toBeLessThanOrEqual(160);
    }
    if (eventos.length) {
      expect(String(caseFile.eventos_aviso)).toContain("abrir_trecho");
    }
  });
});

describe("listar_casos (multi-caso)", () => {
  it("lista os casos da pasta com metadados leves; ignora dirs que não são caso", async () => {
    const { listCases } = await import("../src/core/case-service.js");
    const { mkdirSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "multi-"));
    dirs.push(root);
    await makeCase(root, "caso-a");
    await makeCase(root, "caso-b");
    mkdirSync(join(root, "nao-e-caso"));

    const lista = listCases(root);
    expect(lista.total).toBe(2);
    const ids = lista.casos.map((c) => c.case_id).sort();
    expect(ids).toEqual(["caso-a", "caso-b"]);
    for (const caso of lista.casos) {
      expect(caso.status).toBe("done");
      expect(caso.total_pages).toBe(2);
      expect(caso.documentos_no_caderno).toBe(2);
      expect(caso.atualizado_em).toBeTruthy();
    }

    // Pasta vazia devolve aviso, não erro.
    const vazia = listCases(join(root, "nao-e-caso"));
    expect(vazia.total).toBe(0);
    expect(vazia.aviso).toContain("criar_caso_local");
  });
});
