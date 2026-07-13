import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { verifyReferences } from "../src/core/verifier.js";
import { ingestCase } from "../src/ingest/worker.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const PAGINA_1 =
  "CONTRATO DE FRANQUIA assinado em 15/07/2022 no valor de R$ 2.000.000,00 entre as partes.";

async function makeCase(root: string, caseId: string): Promise<void> {
  const pdf = join(root, "processo.pdf");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 500]);
  p.drawText(PAGINA_1.slice(0, 95), { x: 20, y: 420, size: 9, font });
  writeFileSync(pdf, await doc.save());
  await ingestCase(root, pdf, caseId);
}

const EV = "case:caso-v2:page:1:unit:p001";

describe("verificar_referencias v2 — validação por afirmação (P13 fase 3)", () => {
  it("claim com trecho literal real e literais suportados passa", async () => {
    const root = mkdtempSync(join(tmpdir(), "claims-ok-"));
    dirs.push(root);
    await makeCase(root, "caso-v2");

    const result = await verifyReferences(root, "caso-v2", {
      claims: [
        {
          afirmacao: "O contrato de franquia foi assinado em 15/07/2022.",
          // Trecho copiado do verbatim (a normalização tolera caixa/acentos).
          supports: [{ evidence_id: EV, trecho_base: "CONTRATO DE FRANQUIA assinado em 15/07/2022" }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.claims?.[0].status).toBe("ok");
    expect(result.claims?.[0].supports[0].ok).toBe(true);
  });

  it("trecho inventado é reprovado mesmo com evidence_id válido", async () => {
    const root = mkdtempSync(join(tmpdir(), "claims-forge-"));
    dirs.push(root);
    await makeCase(root, "caso-v2");

    const result = await verifyReferences(root, "caso-v2", {
      claims: [
        {
          afirmacao: "A ré confessou o inadimplemento.",
          supports: [{ evidence_id: EV, trecho_base: "a ré confessou expressamente o inadimplemento" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.claims?.[0].status).toBe("trecho_nao_encontrado");
  });

  it("literal de risco (data/valor) sem lastro no trecho é reprovado", async () => {
    const root = mkdtempSync(join(tmpdir(), "claims-literal-"));
    dirs.push(root);
    await makeCase(root, "caso-v2");

    // Trecho REAL, mas a afirmação traz uma DATA que não está no lastro:
    // a alucinação clássica de "data quase certa".
    const result = await verifyReferences(root, "caso-v2", {
      claims: [
        {
          afirmacao: "O contrato foi assinado em 14/07/2022 no valor de R$ 2.000.000,00.",
          supports: [
            { evidence_id: EV, trecho_base: "no valor de R$ 2.000.000,00 entre as partes" },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.claims?.[0].status).toBe("literal_nao_suportado");
    expect(result.claims?.[0].problemas.join(" ")).toContain("14/07/2022");
  });

  it("evidence_id inexistente e claim sem supports são reprovados", async () => {
    const root = mkdtempSync(join(tmpdir(), "claims-missing-"));
    dirs.push(root);
    await makeCase(root, "caso-v2");

    const result = await verifyReferences(root, "caso-v2", {
      claims: [
        {
          afirmacao: "Fato sem evidência.",
          supports: [{ evidence_id: "case:caso-v2:page:99:unit:p001", trecho_base: "x" }],
        },
      ],
    });
    expect(result.claims?.[0].status).toBe("evidencia_inexistente");
  });

  it("doc_id não registrado reprova o claim; modo legado segue funcionando", async () => {
    const root = mkdtempSync(join(tmpdir(), "claims-doc-"));
    dirs.push(root);
    await makeCase(root, "caso-v2");

    const comDoc = await verifyReferences(root, "caso-v2", {
      claims: [
        {
          afirmacao: "Precedente aplicável ao caso.",
          supports: [{ evidence_id: EV, trecho_base: "CONTRATO DE FRANQUIA" }],
          doc_ids: ["stj-resp-123"],
        },
      ],
    });
    expect(comDoc.claims?.[0].status).toBe("doc_id_nao_registrado");

    // Legado (só listas) intocado.
    const legado = await verifyReferences(root, "caso-v2", {
      evidence_ids: [EV],
      doc_ids: [],
    });
    expect(legado.ok).toBe(true);
  });
});
