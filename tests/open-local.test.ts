import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { openPage } from "../src/core/case-service.js";
import { openOnComputer } from "../src/core/open-local.js";
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
  for (const body of ["PETIÇÃO INICIAL: o autor requer a condenação da ré.", "CERTIDÃO de citação."]) {
    const p = doc.addPage([595, 500]);
    p.drawText(body.slice(0, 90), { x: 30, y: 420, size: 10, font });
  }
  writeFileSync(pdf, await doc.save());
  await ingestCase(root, pdf, caseId);
}

describe("conferir no original (P8)", () => {
  it("abrir_no_computador gera o PDF da página e abre via opener, dentro da pasta do caso", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-local-"));
    dirs.push(root);
    await makeCase(root, "caso-open");

    const opened: Array<{ path: string; revelar: boolean }> = [];
    const opener = (path: string, revelar: boolean) => opened.push({ path, revelar });

    const result = await openOnComputer(root, "caso-open", { page: 2 }, opener);
    expect(result.acao).toBe("abertura_solicitada");
    expect(result.page).toBe(2);
    // O caminho é DERIVADO (case_id + página), nunca vem do chamador, e fica
    // dentro da pasta do caso.
    expect(result.arquivo.startsWith(join(root, "caso-open"))).toBe(true);
    expect(result.arquivo.endsWith("page-000002.pdf")).toBe(true);
    expect(existsSync(result.arquivo)).toBe(true);
    expect(opened).toEqual([{ path: result.arquivo, revelar: false }]);

    const revelado = await openOnComputer(root, "caso-open", { page: 2, revelar: true }, opener);
    expect(revelado.acao).toBe("revelacao_solicitada");
    expect(opened[1].revelar).toBe(true);
  });

  it("alvo=processo abre o PDF integral; página inválida é recusada", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-proc-"));
    dirs.push(root);
    await makeCase(root, "caso-proc");
    const opened: string[] = [];

    const result = await openOnComputer(
      root,
      "caso-proc",
      { alvo: "processo" },
      (path) => opened.push(path),
    );
    expect(result.arquivo.endsWith("processo.pdf")).toBe(true);
    expect(opened).toHaveLength(1);

    await expect(openOnComputer(root, "caso-proc", { alvo: "pagina" }, () => {})).rejects.toThrow(
      /pagina/i,
    );
  });

  it("abrir_pagina devolve 'original' com caminho local e link file:// clicável", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-link-"));
    dirs.push(root);
    await makeCase(root, "caso-link");

    const page = await openPage(root, "caso-link", 1);
    expect(page.original).toBeDefined();
    expect(existsSync(page.original!.arquivo)).toBe(true);
    expect(page.original!.link.startsWith("file:///")).toBe(true);
    expect(page.original!.link.endsWith("page-000001.pdf")).toBe(true);
  });
});
