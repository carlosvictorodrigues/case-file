import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ingestCase } from "../src/ingest/worker.js";
import { buildEvidenceBundle } from "../src/core/case-service.js";
import { registerJurisprudence } from "../src/core/jurisprudence.js";
import { verifyReferences } from "../src/core/verifier.js";

async function makePdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([500, 500]);
  page.drawText("Autor sofreu negativacao indevida apos pagamento.", {x: 50, y: 420, size: 12, font});
  writeFileSync(path, await pdf.save());
}

describe("evidence bundle and verifier", () => {
  it("builds a small bundle and verifies local references", async () => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    const pdf = join(root, "processo.pdf");
    await makePdf(pdf);
    await ingestCase(root, pdf, "caso");
    const bundle = await buildEvidenceBundle(root, "caso", "jurisprudencia_favoravel_e_oportunidades", "autor", 5);
    expect(bundle.fatos_relevantes[0].evidence_id).toBe("case:caso:page:1:unit:p001");
    const ok = await verifyReferences(root, "caso", {evidence_ids: [bundle.fatos_relevantes[0].evidence_id], doc_ids: []});
    expect(ok.ok).toBe(true);
    const bad = await verifyReferences(root, "caso", {evidence_ids: ["case:caso:page:99:unit:p001"], doc_ids: []});
    expect(bad.ok).toBe(false);
    expect(bad.missing_evidence_ids).toEqual(["case:caso:page:99:unit:p001"]);
  });

  it("rejects invented doc ids even if the caller supplies them and accepts locally persisted ids", async () => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    const pdf = join(root, "processo.pdf");
    await makePdf(pdf);
    await ingestCase(root, pdf, "caso");

    writeFileSync(
      join(root, "caso", "artifacts", "jurisprudence_bundle.json"),
      JSON.stringify({
        documents: [
          { doc_id: "doc-local-1", titulo: "Tema local" },
        ],
      }),
      "utf8",
    );

    const accepted = await verifyReferences(root, "caso", {
      evidence_ids: [],
      doc_ids: ["doc-local-1"],
      jurisprudence_doc_ids: ["doc-inventado"],
    });
    expect(accepted).toMatchObject({
      ok: true,
      missing_doc_ids: [],
    });

    const rejected = await verifyReferences(root, "caso", {
      evidence_ids: [],
      doc_ids: ["doc-inventado"],
      jurisprudence_doc_ids: ["doc-inventado"],
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.missing_doc_ids).toEqual(["doc-inventado"]);
  });

  it("accepts doc ids registered via registrar_jurisprudencia and guides when nothing is registered", async () => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    const pdf = join(root, "processo.pdf");
    await makePdf(pdf);
    await ingestCase(root, pdf, "caso");

    const unregistered = await verifyReferences(root, "caso", {
      evidence_ids: [],
      doc_ids: ["stj-123"],
    });
    expect(unregistered.ok).toBe(false);
    expect(unregistered.missing_doc_ids).toEqual(["stj-123"]);
    expect(unregistered.errors.join(" ")).toContain("registrar_jurisprudencia");

    const registered = registerJurisprudence(root, "caso", [
      { doc_id: "stj-123", titulo: "REsp exemplo", tribunal: "STJ" },
    ]);
    expect(registered).toMatchObject({ registered: 1, total: 1 });

    const verified = await verifyReferences(root, "caso", {
      evidence_ids: [],
      doc_ids: ["stj-123"],
    });
    expect(verified.ok).toBe(true);
    expect(verified.missing_doc_ids).toEqual([]);
  });

  it("reports operational evidence lookup errors separately from missing evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    const pdf = join(root, "processo.pdf");
    await makePdf(pdf);
    await ingestCase(root, pdf, "caso");

    const result = await verifyReferences(root, "caso-ausente", {
      evidence_ids: ["case:caso:page:1:unit:p001"],
      doc_ids: [],
    });

    expect(result.ok).toBe(false);
    expect(result.missing_evidence_ids).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("ENOENT");
  });
});
