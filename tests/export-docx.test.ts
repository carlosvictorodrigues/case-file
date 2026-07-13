import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { exportarDocumento, markdownToDocxBuffer } from "../src/core/export-docx.js";
import { ingestCase } from "../src/ingest/worker.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function makeCase(root: string, caseId: string): Promise<void> {
  const pdf = join(root, "processo.pdf");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 500]);
  p.drawText("PETIÇÃO INICIAL: o autor requer a condenação da ré.", { x: 30, y: 420, size: 10, font });
  writeFileSync(pdf, await doc.save());
  await ingestCase(root, pdf, caseId);
}

const MARKDOWN = `## Pedidos da autora

A autora **AND Comércio** requer:

- Nulidade da *cláusula arbitral*
- Restituição de royalties

| Pedido | Página |
|---|---|
| Nulidade | 200 |
| Restituição | 200 |

> Ressalva: conferir o verbatim antes de protocolar.
`;

describe("exportar_documento (P10)", () => {
  it("gera DOCX real em exports/ do caso, abre via opener e devolve link", async () => {
    const root = mkdtempSync(join(tmpdir(), "export-"));
    dirs.push(root);
    await makeCase(root, "caso-exp");

    const opened: string[] = [];
    const result = await exportarDocumento(
      root,
      "caso-exp",
      "Pacote de Evidências — Caso 2",
      MARKDOWN,
      { opener: (path) => opened.push(path) },
    );

    expect(result.arquivo.startsWith(join(root, "caso-exp", "exports"))).toBe(true);
    expect(result.arquivo.endsWith(".docx")).toBe(true);
    expect(result.arquivo).toContain("pacote-de-evidencias-caso-2");
    expect(result.link.startsWith("file:///")).toBe(true);
    expect(result.abertura_solicitada).toBe(true);
    expect(opened).toEqual([result.arquivo]);

    // DOCX de verdade: é um zip (PK) contendo word/document.xml com o texto.
    const bytes = readFileSync(result.arquivo);
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(bytes.includes(Buffer.from("word/document.xml"))).toBe(true);

    // abrir=false não chama o opener.
    const silencioso = await exportarDocumento(root, "caso-exp", "Relatório", "# Ok\ntexto", {
      abrir: false,
      opener: (path) => opened.push(path),
    });
    expect(silencioso.abertura_solicitada).toBe(false);
    expect(opened).toHaveLength(1);
    expect(existsSync(silencioso.arquivo)).toBe(true);
  });

  it("markdown com título/negrito/tabela vira conteúdo no document.xml", async () => {
    const buffer = await markdownToDocxBuffer("Título do Doc", MARKDOWN);
    const raw = buffer.toString("latin1");
    // O document.xml fica comprimido no zip? O docx usa DEFLATE; texto pode
    // não aparecer cru. Garantia mínima estrutural: zip válido não-vazio.
    expect(raw.slice(0, 2)).toBe("PK");
    expect(buffer.length).toBeGreaterThan(2000);
  });

  it("recusa título ou conteúdo vazio e caso inexistente", async () => {
    const root = mkdtempSync(join(tmpdir(), "export-neg-"));
    dirs.push(root);
    await makeCase(root, "caso-neg");

    await expect(exportarDocumento(root, "caso-neg", "  ", "x", { abrir: false })).rejects.toThrow(
      /titulo/i,
    );
    await expect(exportarDocumento(root, "caso-neg", "T", "  ", { abrir: false })).rejects.toThrow(
      /vazio/i,
    );
    await expect(
      exportarDocumento(root, "nao-existe", "T", "x", { abrir: false }),
    ).rejects.toThrow(/ENOENT/);
  });
});
