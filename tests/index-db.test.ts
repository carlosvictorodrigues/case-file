import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CaseIndex } from "../src/storage/index-db.js";
import type { EvidenceUnit } from "../src/domain/types.js";

let dirs: string[] = [];

function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "case-index-"));
  dirs.push(d);
  return join(d, "case.sqlite");
}

function tmpDir(prefix = "case-index-root-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function unit(id: string, text: string): EvidenceUnit {
  return {
    evidence_id: id,
    case_id: "caso",
    page: 1,
    unit_id: id.split(":").pop() ?? "p001",
    unit_type: "paragraph",
    start_offset: 0,
    end_offset: text.length,
    text,
    hash: "h",
    display_ref: "fl. 1",
  };
}

describe("CaseIndex", () => {
  it("creates an FTS5 table and searches text", async () => {
    const path = tmpDb();
    const db = await CaseIndex.open(path, join(path, ".."));
    db.upsertEvidence([
      unit("case:caso:page:1:unit:p001", "comprovante de pagamento juntado"),
      unit("case:caso:page:2:unit:p001", "contestacao fala de prescricao"),
    ]);
    const results = db.search("pagamento", 5);
    expect(results).toHaveLength(1);
    expect(results[0].evidence_id).toBe("case:caso:page:1:unit:p001");
    db.close();
  });

  it("ranks by bm25, returns snippets and falls back to OR for natural queries", async () => {
    const path = tmpDb();
    const root = join(path, "..");
    const db = await CaseIndex.open(path, root);
    db.upsertEvidence([
      unit(
        "case:caso:page:1:unit:p001",
        "certidão de citação do réu realizada por oficial de justiça, citação juntada aos autos",
      ),
      unit(
        "case:caso:page:2:unit:p001",
        "despacho de mero expediente sobre a distribuição do feito e outras providências ordinárias sem relação com o mérito, mencionando citação uma única vez",
      ),
    ]);

    // Ranking: página onde o termo domina vem primeiro.
    const ranked = db.search("citação", 5);
    expect(ranked[0].evidence_id).toBe("case:caso:page:1:unit:p001");
    expect(ranked[0].snippet).toContain("«");

    // Consulta natural: AND de todos os tokens falharia; o fallback OR acha.
    const natural = db.search("quando o réu foi citado nos autos", 5);
    expect(natural.length).toBeGreaterThan(0);
    expect(natural[0].page).toBe(1);
    db.close();
  });

  it("shares one live instance between concurrent handles (no lost writes)", async () => {
    const path = tmpDb();
    const root = join(path, "..");
    // Simula o worker de ingest (writer) e uma tool (reader) abertos ao
    // mesmo tempo: antes, cada handle era uma cópia independente do arquivo
    // e o close() do reader reescrevia o snapshot velho por cima do writer.
    const writer = await CaseIndex.open(path, root);
    const reader = await CaseIndex.open(path, root);
    writer.upsertEvidence([unit("case:caso:page:1:unit:p001", "pagamento efetuado")]);
    expect(reader.getEvidence("case:caso:page:1:unit:p001")?.text).toBe("pagamento efetuado");
    reader.close();
    writer.upsertEvidence([unit("case:caso:page:2:unit:p001", "citacao do reu")]);
    writer.close();
    const reopened = await CaseIndex.open(path, root);
    expect(reopened.getEvidence("case:caso:page:1:unit:p001")).toBeDefined();
    expect(reopened.getEvidence("case:caso:page:2:unit:p001")).toBeDefined();
    reopened.close();
  });

  it("persists evidence to disk", async () => {
    const path = tmpDb();
    const db = await CaseIndex.open(path, join(path, ".."));
    db.upsertEvidence([unit("case:caso:page:1:unit:p001", "dano moral")]);
    db.close();
    const reopened = await CaseIndex.open(path, join(path, ".."));
    expect(reopened.getEvidence("case:caso:page:1:unit:p001")?.text).toBe(
      "dano moral",
    );
    reopened.close();
  });

  it("replaces existing evidence text in the FTS index", async () => {
    const path = tmpDb();
    const db = await CaseIndex.open(path, join(path, ".."));
    const evidenceId = "case:caso:page:1:unit:p001";

    db.upsertEvidence([unit(evidenceId, "pagamento original")]);
    expect(db.search("original", 5).map((row) => row.evidence_id)).toEqual([
      evidenceId,
    ]);

    db.upsertEvidence([unit(evidenceId, "pagamento atualizado")]);

    expect(db.search("original", 5)).toHaveLength(0);
    expect(db.search("atualizado", 5).map((row) => row.evidence_id)).toEqual([
      evidenceId,
    ]);

    db.close();
  });

  it("persists OCR evidence metadata and keeps it searchable", async () => {
    const path = tmpDb();
    const db = await CaseIndex.open(path, join(path, ".."));
    const evidence: EvidenceUnit = {
      evidence_id: "case:caso:page:2:unit:ocr001",
      case_id: "caso",
      page: 2,
      unit_id: "ocr001",
      unit_type: "ocr_paragraph",
      start_offset: 0,
      end_offset: "mandado de citacao".length,
      text: "mandado de citacao",
      hash: "h",
      source_path: "pages/page-000002.ocr.txt",
      image_ref: {
        page_image_path: "pages/page-000002.png",
        region_path: "visual/page-000002-ocr001.png",
        bbox: [0.1, 0.2, 0.8, 0.3],
      },
      ocr: {
        provider: "google",
        model: "gemini-2.5-flash",
        reading_confidence: 0.78,
        warning: "transcricao por OCR, conferir no original",
      },
    };

    db.upsertEvidence([evidence]);
    db.close();

    const reopened = await CaseIndex.open(path, join(path, ".."));
    expect(reopened.getEvidence(evidence.evidence_id)).toMatchObject({
      unit_type: "ocr_paragraph",
      image_ref: evidence.image_ref,
      ocr: evidence.ocr,
    });
    expect(reopened.search("citacao", 5).map((row) => row.evidence_id)).toEqual([
      evidence.evidence_id,
    ]);
    reopened.close();
  });

  it("treats punctuation in user search text as plain text", async () => {
    const path = tmpDb();
    const db = await CaseIndex.open(path, join(path, ".."));
    const evidenceId = "case:caso:page:1:unit:p001";

    db.upsertEvidence([unit(evidenceId, "documento citado em fl. 1 do processo")]);

    expect(db.search("fl. 1", 5).map((row) => row.evidence_id)).toEqual([
      evidenceId,
    ]);

    db.close();
  });

  it("rejects opening a database outside the authorized root", async () => {
    const authorizedRoot = tmpDir("case-index-authorized-");
    const outsidePath = join(tmpDir("case-index-outside-"), "case.sqlite");

    await expect(CaseIndex.open(outsidePath, authorizedRoot)).rejects.toThrow(
      /outside the authorized cases directory/i,
    );
  });

  it("rejects writing a new database outside the authorized root", async () => {
    const authorizedRoot = tmpDir("case-index-authorized-");
    const outsidePath = join(tmpDir("case-index-outside-"), "new-case.sqlite");

    await expect(CaseIndex.open(outsidePath, authorizedRoot)).rejects.toThrow(
      /outside the authorized cases directory/i,
    );
  });

  it("rejects malformed evidence units missing offsets before persistence", async () => {
    const path = tmpDb();
    const db = await CaseIndex.open(path, join(path, ".."));
    const malformed = {
      evidence_id: "case:caso:page:1:unit:p001",
      case_id: "caso",
      page: 1,
      unit_id: "p001",
      unit_type: "paragraph",
      hash: "h",
      text: "texto sem offsets",
    } as EvidenceUnit;

    expect(() => db.upsertEvidence([malformed])).toThrow(/start_offset/i);
    expect(db.getEvidence(malformed.evidence_id)).toBeUndefined();

    db.close();
  });

  it("rejects evidence units with negative offsets before persistence", async () => {
    const path = tmpDb();
    const db = await CaseIndex.open(path, join(path, ".."));
    const invalid = {
      evidence_id: "case:caso:page:1:unit:p001",
      case_id: "caso",
      page: 1,
      unit_id: "p001",
      unit_type: "paragraph",
      start_offset: -5,
      end_offset: 0,
      hash: "h",
      text: "texto com offset negativo",
    } as EvidenceUnit;

    expect(() => db.upsertEvidence([invalid])).toThrow(/start_offset/i);
    expect(db.getEvidence(invalid.evidence_id)).toBeUndefined();

    db.close();
  });
});
