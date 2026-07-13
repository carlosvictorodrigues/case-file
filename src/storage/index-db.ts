import type { EvidenceUnit } from "../domain/types.js";
import { openSqlDatabase, type OpenedSqlDatabase, type SqlDatabase } from "./sqlite.js";

const USER_QUERY_TOKEN = /[\p{L}\p{N}]+/gu;

function quoteFtsToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}

export interface SearchHit extends EvidenceUnit {
  /** Trecho ao redor do match (FTS5 snippet), com «» marcando os termos. */
  snippet?: string;
  /** bm25 do FTS5 — menor é mais relevante. */
  score?: number;
}

export class CaseIndex {
  private db: SqlDatabase;

  private constructor(
    private opened: OpenedSqlDatabase,
  ) {
    this.db = opened.db;
  }

  static async open(dbPath: string, authorizedRoot: string): Promise<CaseIndex> {
    const opened = await openSqlDatabase(dbPath, authorizedRoot);
    const index = new CaseIndex(opened);
    index.initSchema();
    return index;
  }

  private initSchema(): void {
    const evidenceChanged = this.ensureEvidenceSchema();
    const ftsChanged = this.ensureFtsSchema();
    this.db.run(`
      CREATE TABLE IF NOT EXISTS evidence_vectors (
        evidence_id TEXT NOT NULL,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (evidence_id, model)
      );
    `);
    // Rebuild only after a schema (re)creation/migration; upsertEvidence keeps
    // the FTS table in sync incrementally, so a plain open must stay read-only.
    if (evidenceChanged || ftsChanged) {
      this.rebuildFtsIndex();
      this.flush();
    }
  }

  private ensureEvidenceSchema(): boolean {
    const stmt = this.db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'evidence_units'
    `);
    try {
      const hasTable = stmt.step();
      const sql = hasTable ? String(stmt.getAsObject().sql ?? "") : "";
      const needsMigration =
        hasTable &&
        (!sql.includes("start_offset INTEGER NOT NULL") ||
          !sql.includes("end_offset INTEGER NOT NULL") ||
          !sql.includes("image_ref_json TEXT") ||
          !sql.includes("ocr_json TEXT"));

      if (!hasTable) {
        this.createEvidenceUnitsTable("evidence_units");
        return true;
      }

      if (needsMigration) {
        this.createEvidenceUnitsTable("evidence_units_v2");
        this.db.run(`
          INSERT INTO evidence_units_v2 (
            evidence_id, case_id, page, folio_label, event_id, display_ref, unit_id, unit_type,
            start_offset, end_offset, hash, source_path, text, image_ref_json, ocr_json
          )
          SELECT
            evidence_id, case_id, page, folio_label, event_id, display_ref, unit_id, unit_type,
            start_offset, end_offset, hash, source_path, text, NULL, NULL
          FROM evidence_units
        `);
        this.db.run("DROP TABLE evidence_units");
        this.db.run("ALTER TABLE evidence_units_v2 RENAME TO evidence_units");
        return true;
      }
      return false;
    } finally {
      stmt.free();
    }
  }

  private createEvidenceUnitsTable(tableName: string): void {
    this.db.run(`
      CREATE TABLE ${tableName} (
        evidence_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        folio_label TEXT,
        event_id TEXT,
        display_ref TEXT,
        unit_id TEXT NOT NULL,
        unit_type TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        hash TEXT NOT NULL,
        source_path TEXT,
        text TEXT,
        image_ref_json TEXT,
        ocr_json TEXT
      );
    `);
  }

  private ensureFtsSchema(): boolean {
    const stmt = this.db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'evidence_fts'
    `);
    try {
      const hasTable = stmt.step();
      const sql = hasTable ? String(stmt.getAsObject().sql ?? "") : "";
      if (hasTable && sql.includes("content=''")) {
        this.db.run("DROP TABLE evidence_fts");
      }
      if (!hasTable || sql.includes("content=''")) {
        this.db.run(`
          CREATE VIRTUAL TABLE evidence_fts
          USING fts5(evidence_id UNINDEXED, text);
        `);
        return true;
      }
      return false;
    } finally {
      stmt.free();
    }
  }

  private rebuildFtsIndex(): void {
    this.db.run("DELETE FROM evidence_fts");
    this.db.run(`
      INSERT INTO evidence_fts (rowid, evidence_id, text)
      SELECT rowid, evidence_id, COALESCE(text, "")
      FROM evidence_units
    `);
  }

  upsertEvidence(units: EvidenceUnit[]): void {
    for (const unit of units) {
      this.assertValidEvidenceUnit(unit);
    }

    const insert = this.db.prepare(`
      INSERT INTO evidence_units
      (evidence_id, case_id, page, folio_label, event_id, display_ref, unit_id, unit_type,
       start_offset, end_offset, hash, source_path, text, image_ref_json, ocr_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(evidence_id) DO UPDATE SET
        case_id = excluded.case_id,
        page = excluded.page,
        folio_label = excluded.folio_label,
        event_id = excluded.event_id,
        display_ref = excluded.display_ref,
        unit_id = excluded.unit_id,
        unit_type = excluded.unit_type,
        start_offset = excluded.start_offset,
        end_offset = excluded.end_offset,
        hash = excluded.hash,
        source_path = excluded.source_path,
        text = excluded.text,
        image_ref_json = excluded.image_ref_json,
        ocr_json = excluded.ocr_json
    `);
    const selectRowId = this.db.prepare(
      "SELECT rowid FROM evidence_units WHERE evidence_id = ?",
    );
    const ftsDelete = this.db.prepare("DELETE FROM evidence_fts WHERE rowid = ?");
    const ftsInsert = this.db.prepare(
      "INSERT INTO evidence_fts (rowid, evidence_id, text) VALUES (?, ?, ?)",
    );
    try {
      this.db.run("BEGIN");
      for (const u of units) {
        insert.run([
          u.evidence_id,
          u.case_id,
          u.page,
          u.folio_label ?? null,
          u.event_id ?? null,
          u.display_ref ?? null,
          u.unit_id,
          u.unit_type,
          u.start_offset ?? null,
          u.end_offset ?? null,
          u.hash,
          u.source_path ?? null,
          u.text ?? "",
          u.image_ref ? JSON.stringify(u.image_ref) : null,
          u.ocr ? JSON.stringify(u.ocr) : null,
        ]);
        selectRowId.bind([u.evidence_id]);
        if (!selectRowId.step()) {
          throw new Error(`Missing evidence row after upsert: ${u.evidence_id}`);
        }
        const rowId = Number(selectRowId.getAsObject().rowid);
        selectRowId.reset();
        ftsDelete.run([rowId]);
        ftsInsert.run([rowId, u.evidence_id, u.text ?? ""]);
      }
      this.db.run("COMMIT");
    } catch (err) {
      this.db.run("ROLLBACK");
      throw err;
    } finally {
      insert.free();
      selectRowId.free();
      ftsDelete.free();
      ftsInsert.free();
    }
    this.flush();
  }

  search(query: string, limit: number): SearchHit[] {
    const tokens = this.tokenize(query);
    if (!tokens.length) {
      return [];
    }
    const hits = this.searchFts(tokens.map(quoteFtsToken).join(" AND "), limit);
    if (hits.length || tokens.length < 2) {
      return hits;
    }
    // Consulta em linguagem natural raramente tem TODOS os tokens na mesma
    // página; o fallback OR com ranking bm25 mantém o recall sem ruído no topo.
    return this.searchFts(tokens.map(quoteFtsToken).join(" OR "), limit);
  }

  private searchFts(matchQuery: string, limit: number): SearchHit[] {
    const stmt = this.db.prepare(`
      SELECT u.*,
             snippet(evidence_fts, 1, '«', '»', ' … ', 24) AS _snippet,
             bm25(evidence_fts) AS _score
      FROM evidence_fts
      JOIN evidence_units u ON u.rowid = evidence_fts.rowid
      WHERE evidence_fts MATCH ?
      ORDER BY bm25(evidence_fts)
      LIMIT ?
    `);
    try {
      const rows: SearchHit[] = [];
      stmt.bind([matchQuery, limit]);
      while (stmt.step()) {
        const raw = stmt.getAsObject();
        rows.push({
          ...this.rowToUnit(raw),
          snippet: typeof raw._snippet === "string" ? raw._snippet : undefined,
          score: typeof raw._score === "number" ? raw._score : undefined,
        });
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  private tokenize(query: string): string[] {
    return query.match(USER_QUERY_TOKEN) ?? [];
  }

  getEvidence(evidenceId: string): EvidenceUnit | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM evidence_units WHERE evidence_id = ?",
    );
    try {
      stmt.bind([evidenceId]);
      if (!stmt.step()) return undefined;
      return this.rowToUnit(stmt.getAsObject());
    } finally {
      stmt.free();
    }
  }

  private rowToUnit(row: Record<string, unknown>): EvidenceUnit {
    const imageRef =
      typeof row.image_ref_json === "string" && row.image_ref_json.length
        ? JSON.parse(row.image_ref_json)
        : undefined;
    const ocr =
      typeof row.ocr_json === "string" && row.ocr_json.length
        ? JSON.parse(row.ocr_json)
        : undefined;

    return {
      evidence_id: String(row.evidence_id),
      case_id: String(row.case_id),
      page: Number(row.page),
      folio_label: row.folio_label ? String(row.folio_label) : undefined,
      event_id: row.event_id ? String(row.event_id) : undefined,
      display_ref: row.display_ref ? String(row.display_ref) : undefined,
      unit_id: String(row.unit_id),
      unit_type: row.unit_type as EvidenceUnit["unit_type"],
      start_offset: this.readRequiredOffset("start_offset", row.start_offset),
      end_offset: this.readRequiredOffset("end_offset", row.end_offset),
      hash: String(row.hash),
      source_path: row.source_path ? String(row.source_path) : undefined,
      text: row.text ? String(row.text) : undefined,
      image_ref: imageRef,
      ocr,
    };
  }

  private assertValidEvidenceUnit(unit: EvidenceUnit): void {
    const label = unit.evidence_id || "<unknown evidence_id>";
    if (!this.isValidOffset(unit.start_offset)) {
      throw new Error(`Evidence unit ${label} has invalid start_offset`);
    }
    if (!this.isValidOffset(unit.end_offset)) {
      throw new Error(`Evidence unit ${label} has invalid end_offset`);
    }
    if (unit.end_offset < unit.start_offset) {
      throw new Error(`Evidence unit ${label} has end_offset before start_offset`);
    }
  }

  private readRequiredOffset(name: "start_offset" | "end_offset", value: unknown): number {
    if (!this.isValidOffset(value)) {
      throw new Error(`Stored evidence row has invalid ${name}`);
    }
    return Number(value);
  }

  private isValidOffset(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
  }

  listUnits(): EvidenceUnit[] {
    const stmt = this.db.prepare(
      "SELECT * FROM evidence_units ORDER BY page ASC, unit_id ASC",
    );
    try {
      const rows: EvidenceUnit[] = [];
      while (stmt.step()) rows.push(this.rowToUnit(stmt.getAsObject()));
      return rows;
    } finally {
      stmt.free();
    }
  }

  upsertVectors(
    entries: Array<{ evidence_id: string; model: string; vector: number[] }>,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO evidence_vectors (evidence_id, model, dim, vector, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(evidence_id, model) DO UPDATE SET
        dim = excluded.dim,
        vector = excluded.vector,
        updated_at = excluded.updated_at
    `);
    try {
      this.db.run("BEGIN");
      const now = new Date().toISOString();
      for (const entry of entries) {
        const bytes = new Uint8Array(Float32Array.from(entry.vector).buffer);
        stmt.run([entry.evidence_id, entry.model, entry.vector.length, bytes, now]);
        stmt.reset();
      }
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    } finally {
      stmt.free();
    }
    this.flush();
  }

  /**
   * Remove os vetores (todas as versões de espaço) das evidências dadas.
   * Usado quando o texto de uma evidência é SUBSTITUÍDO (re-OCR): o vetor
   * antigo descreveria conteúdo que não existe mais — melhor faltar (e ser
   * re-embedado no próximo indexar_semantica) do que apontar errado.
   */
  deleteVectorsForEvidence(evidenceIds: string[]): void {
    if (!evidenceIds.length) return;
    const stmt = this.db.prepare("DELETE FROM evidence_vectors WHERE evidence_id = ?");
    try {
      this.db.run("BEGIN");
      for (const evidenceId of evidenceIds) {
        stmt.run([evidenceId]);
        stmt.reset();
      }
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    } finally {
      stmt.free();
    }
    this.flush();
  }

  listVectors(model: string): Array<{ evidence_id: string; vector: Float32Array }> {
    const stmt = this.db.prepare(
      "SELECT evidence_id, vector FROM evidence_vectors WHERE model = ?",
    );
    try {
      const rows: Array<{ evidence_id: string; vector: Float32Array }> = [];
      stmt.bind([model]);
      while (stmt.step()) {
        const raw = stmt.getAsObject();
        const bytes = raw.vector as Uint8Array;
        rows.push({
          evidence_id: String(raw.evidence_id),
          vector: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
        });
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  /** Unidades com texto que ainda não têm vetor para o modelo dado. */
  missingVectorEvidence(
    model: string,
  ): Array<{ evidence_id: string; text: string; page: number }> {
    const stmt = this.db.prepare(`
      SELECT u.evidence_id, u.text, u.page
      FROM evidence_units u
      LEFT JOIN evidence_vectors v
        ON v.evidence_id = u.evidence_id AND v.model = ?
      WHERE v.evidence_id IS NULL AND u.text IS NOT NULL AND length(u.text) > 0
      ORDER BY u.page ASC
    `);
    try {
      const rows: Array<{ evidence_id: string; text: string; page: number }> = [];
      stmt.bind([model]);
      while (stmt.step()) {
        const raw = stmt.getAsObject();
        rows.push({
          evidence_id: String(raw.evidence_id),
          text: String(raw.text),
          page: Number(raw.page),
        });
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  flush(): void {
    this.opened.flush();
  }

  close(): void {
    this.opened.close();
  }
}
