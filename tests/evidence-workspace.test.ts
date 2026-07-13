import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceId, displayRef, sha256, stableCaseId } from "../src/domain/evidence.js";
import type { EvidenceUnit } from "../src/domain/types.js";
import { createWorkspace, resolveInsideRoot } from "../src/storage/workspace.js";

// @ts-expect-error recoverable units must include offsets
const recoverableUnit: EvidenceUnit = {
  evidence_id: "e",
  case_id: "c",
  page: 3,
  unit_id: "p001",
  unit_type: "paragraph",
  hash: "h"
};

function linkDirectoryOrReason(linkPath: string, targetPath: string): string | undefined {
  const attempts: Array<{ type: "junction" | "dir" }> = [
    { type: "junction" },
    { type: "dir" }
  ];
  const errors: string[] = [];

  for (const attempt of attempts) {
    try {
      symlinkSync(targetPath, linkPath, attempt.type);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${attempt.type}: ${message}`);
    }
  }

  return `skipped: unable to create symlink or junction on this machine (${errors.join("; ")})`;
}

describe("evidence helpers", () => {
  it("builds stable evidence ids without hash", () => {
    expect(evidenceId("caso-x", 37, "p004")).toBe("case:caso-x:page:37:unit:p004");
  });

  it("keeps hash as integrity field", () => {
    expect(sha256("texto")).toHaveLength(64);
    expect(sha256("texto")).toBe(sha256("texto"));
  });

  it("renders forensic display refs before physical page fallback", () => {
    expect(displayRef({ ...recoverableUnit, start_offset: 0, end_offset: 1, text: "x", display_ref: "evento 45, fl. 1247" })).toBe("evento 45, fl. 1247");
    expect(displayRef({ ...recoverableUnit, start_offset: 0, end_offset: 1, text: "x" })).toBe("pagina 3 do PDF");
  });

  it("derives deterministic case ids from path basename", () => {
    expect(stableCaseId("/tmp/Meu Processo.pdf")).toBe("meu-processo");
  });
});

describe("workspace guard", () => {
  it("allows paths inside the root", () => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    const allowed = join(root, "caso", "processo.pdf");
    expect(resolveInsideRoot(root, allowed)).toBe(allowed);
  });

  it("rejects path traversal outside the root", () => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    expect(() => resolveInsideRoot(root, join(root, "..", "secret.pdf"))).toThrow("outside the authorized cases directory");
  });

  it("rejects a sibling file when the authorized root does not exist yet", () => {
    const parent = mkdtempSync(join(tmpdir(), "cases-parent-"));
    const root = join(parent, "authorized-root");
    const outside = join(parent, "outside.pdf");
    writeFileSync(outside, "classified");

    expect(() => resolveInsideRoot(root, outside)).toThrow("outside the authorized cases directory");
  });

  it("rejects paths that escape through an existing symlink or junction", ({ skip }) => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    const portal = join(root, "portal");
    const escaped = join(portal, "secret.pdf");

    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.pdf"), "classified");

    const skipReason = linkDirectoryOrReason(portal, outside);
    if (skipReason) {
      skip(skipReason);
    }

    expect(() => resolveInsideRoot(root, escaped)).toThrow("outside the authorized cases directory");
  });

  it("creates the expected case folders", () => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    const pdf = join(root, "processo.pdf");
    writeFileSync(pdf, "fake pdf");
    const ws = createWorkspace(root, pdf, "caso-teste");
    expect(ws.caseId).toBe("caso-teste");
    expect(ws.paths.sourcePdf.endsWith("source/processo.pdf") || ws.paths.sourcePdf.endsWith("source\\processo.pdf")).toBe(true);
  });

  it("sanitizes hostile slugs before creating workspace paths", () => {
    const root = mkdtempSync(join(tmpdir(), "cases-"));
    const pdf = join(root, "processo.pdf");
    writeFileSync(pdf, "fake pdf");
    const ws = createWorkspace(root, pdf, "..\\..\\escape");
    expect(ws.caseId).toBe("escape");
    expect(() => resolveInsideRoot(root, ws.paths.caseDir)).not.toThrow();
    expect(resolveInsideRoot(root, ws.paths.sourcePdf)).toBe(ws.paths.sourcePdf);
  });
});
