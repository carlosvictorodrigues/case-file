import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeTools } from "../src/tools.js";

async function makePdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([500, 500]);
  page.drawText("PETICAO INICIAL com comprovante de pagamento.", {
    x: 50,
    y: 420,
    size: 12,
    font,
  });
  writeFileSync(path, await pdf.save());
}

describe("tool handlers", () => {
  it("creates, searches, opens, bundles, and verifies a case", async () => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    const pdf = join(root, "processo.pdf");
    await makePdf(pdf);
    const tools = makeTools({ casesDir: root }, { workerStartMode: "inline" });

    const created = await tools.criar_caso_local({
      pdf_path: pdf,
      area: "civil",
      slug: "caso",
    });
    expect(created.case_id).toBe("caso");
    expect((await tools.status_caso({ case_id: "caso" })).status).toBe("done");

    const caseFile = await tools.case_file({ case_id: "caso" });
    expect(caseFile).toMatchObject({ case_id: "caso", area: "civil" });

    const search = await tools.buscar_no_processo({
      case_id: "caso",
      query: "pagamento",
      limit: 5,
    });
    expect(search.results[0].evidence_id).toBe("case:caso:page:1:unit:p001");

    const opened = await tools.ler_original({
      case_id: "caso",
      evidence_id: search.results[0].evidence_id,
    });
    expect(opened.text).toContain("pagamento");

    const page = await tools.ler_original({ case_id: "caso", pagina: 1 });
    expect(page.text).toContain("pagamento");

    // Exatamente um: os dois juntos ou nenhum são recusados.
    await expect(
      tools.ler_original({ case_id: "caso", evidence_id: "x", pagina: 1 }),
    ).rejects.toThrow();
    await expect(tools.ler_original({ case_id: "caso" })).rejects.toThrow();

    const bundle = await tools.montar_pacote_evidencias({
      case_id: "caso",
      objetivo: "jurisprudencia",
      lado: "autor",
      max_items: 5,
    });
    expect(bundle.fatos_relevantes.length).toBeGreaterThan(0);

    const verification = await tools.verificar_referencias({
      case_id: "caso",
      evidence_ids: [search.results[0].evidence_id],
      doc_ids: [],
    });
    expect(verification.ok).toBe(true);
  });

  it("prepares a grounded evidence package for a separate jurisprudence MCP", async () => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    const pdf = join(root, "processo.pdf");
    await makePdf(pdf);
    const tools = makeTools({ casesDir: root }, { workerStartMode: "inline" });

    await tools.criar_caso_local({ pdf_path: pdf, area: "civil", slug: "caso" });
    const bundle = await tools.montar_pacote_evidencias({
      case_id: "caso",
      objetivo: "jurisprudencia favoravel",
      lado: "autor",
      max_items: 5,
    });

    expect(bundle.queries_jurisprudencia[0].query).toContain("pagamento");
    expect(bundle.queries_jurisprudencia[0].fundamento_no_caso[0]).toBe(
      "case:caso:page:1:unit:p001",
    );
  });

  it("returns quickly from create, resumes ingest, and exposes coverage", async () => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    const pdf = join(root, "processo.pdf");
    await makePdf(pdf);
    const tools = makeTools(
      {
        casesDir: root,
        ocrModel: "gemini-2.5-flash",
        ocrMaxConcurrency: 2,
        ocrMaxRetryAttempts: 3,
        ocrApprovalPageThreshold: 25,
      },
      { workerStartMode: "inline" },
    );

    const created = await tools.criar_caso_local({
      pdf_path: pdf,
      area: "civil",
      slug: "caso-phase2",
    });
    expect(created).toMatchObject({ case_id: "caso-phase2", status: "done" });

    const status = await tools.status_caso({ case_id: "caso-phase2" });
    expect(status).toMatchObject({ case_id: "caso-phase2", total_pages: 1 });

    const caseFile = (await tools.case_file({ case_id: "caso-phase2" })) as { cobertura?: unknown };
    expect(caseFile.cobertura).toBeDefined();

    const resumed = await tools.retomar_ingestao({ case_id: "caso-phase2" });
    expect(resumed.case_id).toBe("caso-phase2");
  });

  it("generates radar and exposes coverage in the civil macro", async () => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    const pdf = join(root, "processo.pdf");
    await makePdf(pdf);
    const tools = makeTools(
      {
        casesDir: root,
        ocrModel: "gemini-2.5-flash",
        ocrMaxConcurrency: 2,
        ocrMaxRetryAttempts: 3,
        ocrApprovalPageThreshold: 25,
      },
      { workerStartMode: "inline" },
    );
    await tools.criar_caso_local({ pdf_path: pdf, area: "civil", slug: "caso-radar" });

    const radar = await tools.analisar_radar_processual_civel({
      case_id: "caso-radar",
      lado: "autor",
    });
    expect(radar).toMatchObject({ case_id: "caso-radar" });

    const macro = await tools.analisar_caso_civel({
      case_id: "caso-radar",
      objetivo: "jurisprudencia favoravel",
      lado: "autor",
      max_items: 5,
    });
    expect(macro).toHaveProperty("coverage");
  });
});
