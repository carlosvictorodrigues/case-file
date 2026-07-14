import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  CaseStatus,
  CoverageManifest,
  IngestJob,
  OcrEstimate,
  PageLedgerEntry,
} from "../domain/types.js";
import { openSqlDatabase, type OpenedSqlDatabase } from "../storage/sqlite.js";
import { resolveInsideRoot } from "../storage/workspace.js";

const DEFAULT_HEARTBEAT_DEADLINE_MS = 30_000;
const PROCESSED_STATES = new Set([
  "native_extracted",
  "ocr_done",
  "done",
  "failed_permanent",
  "skipped_no_key",
]);
const NEEDS_OCR_STATES = new Set(["ocr_needed", "ocr_running", "skipped_no_key"]);

interface JobRow extends Record<string, unknown> {
  job_id: string;
  case_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  heartbeat_deadline_ms: number;
  total_pages: number;
  lock_owner?: string;
  lock_acquired_at?: string;
  last_heartbeat_at?: string;
  worker_pid?: number;
  alerts_json: string;
  ocr_estimate_json?: string;
}

export class CaseJobStore {
  private constructor(
    private opened: OpenedSqlDatabase,
    private root: string,
    private artifactsDir: string,
  ) {}

  static async open(
    dbPath: string,
    root: string,
    artifactsDir: string,
  ): Promise<CaseJobStore> {
    const guardedArtifactsDir = resolveInsideRoot(root, artifactsDir);
    mkdirSync(dirname(resolveInsideRoot(root, dbPath)), { recursive: true });
    mkdirSync(guardedArtifactsDir, { recursive: true });
    const opened = await openSqlDatabase(dbPath, root);
    const store = new CaseJobStore(opened, root, guardedArtifactsDir);
    store.initSchema();
    return store;
  }

  createJob(caseId: string, totalPages: number, now: string): IngestJob {
    const stamp = now.replace(/\D/g, "").slice(0, 14);
    const job: IngestJob = {
      job_id: `job-${caseId}-${stamp}`,
      case_id: caseId,
      status: "queued",
      created_at: now,
      updated_at: now,
      heartbeat_deadline_ms: DEFAULT_HEARTBEAT_DEADLINE_MS,
      alerts: [],
      ocr_estimate: {
        pages: 0,
        calls: 0,
        requires_approval: false,
        approved: true,
      },
    };
    const stmt = this.opened.db.prepare(`
      INSERT INTO ingest_jobs (
        job_id, case_id, status, created_at, updated_at, heartbeat_deadline_ms,
        total_pages, lock_owner, lock_acquired_at, last_heartbeat_at, worker_pid,
        alerts_json, ocr_estimate_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at,
        heartbeat_deadline_ms = excluded.heartbeat_deadline_ms,
        total_pages = excluded.total_pages,
        alerts_json = excluded.alerts_json,
        ocr_estimate_json = excluded.ocr_estimate_json
    `);
    try {
      stmt.run([
        job.job_id,
        job.case_id,
        job.status,
        job.created_at,
        job.updated_at,
        job.heartbeat_deadline_ms,
        totalPages,
        null,
        null,
        null,
        null,
        JSON.stringify(job.alerts),
        JSON.stringify(job.ocr_estimate),
      ]);
      this.opened.flush();
      return job;
    } finally {
      stmt.free();
    }
  }

  getLatestJob(caseId: string): IngestJob | undefined {
    const row = this.getLatestJobRow(caseId);
    return row ? this.rowToJob(row) : undefined;
  }

  getJob(jobId: string): IngestJob | undefined {
    const row = this.getJobRow(jobId);
    return row ? this.rowToJob(row) : undefined;
  }

  updateJob(jobId: string, patch: Partial<IngestJob>): IngestJob {
    const current = this.getJob(jobId);
    if (!current) throw new Error(`Ingest job not found: ${jobId}`);
    const next = { ...current, ...patch };
    const stmt = this.opened.db.prepare(`
      UPDATE ingest_jobs
      SET status = ?, updated_at = ?, heartbeat_deadline_ms = ?, lock_owner = ?,
          lock_acquired_at = ?, last_heartbeat_at = ?, worker_pid = ?,
          alerts_json = ?, ocr_estimate_json = ?
      WHERE job_id = ?
    `);
    try {
      stmt.run([
        next.status,
        next.updated_at,
        next.heartbeat_deadline_ms,
        next.lock_owner ?? null,
        next.lock_acquired_at ?? null,
        next.last_heartbeat_at ?? null,
        next.worker_pid ?? null,
        JSON.stringify(next.alerts),
        next.ocr_estimate ? JSON.stringify(next.ocr_estimate) : null,
        jobId,
      ]);
      this.opened.flush();
      return next;
    } finally {
      stmt.free();
    }
  }

  upsertPage(entry: PageLedgerEntry): void {
    const stmt = this.opened.db.prepare(`
      INSERT INTO page_ledger (
        case_id, page, page_hash, state, text_quality_score,
        text_quality_reasons_json, native_text_chars, native_text_hash,
        piece_type, piece_confidence, ocr_needed, ocr_attempts,
        ocr_last_error_kind, ocr_last_error_message, ocr_yield,
        ocr_prompt_version, evidence_ids_json, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_id, page) DO UPDATE SET
        page_hash = excluded.page_hash,
        state = excluded.state,
        text_quality_score = excluded.text_quality_score,
        text_quality_reasons_json = excluded.text_quality_reasons_json,
        native_text_chars = excluded.native_text_chars,
        native_text_hash = excluded.native_text_hash,
        piece_type = excluded.piece_type,
        piece_confidence = excluded.piece_confidence,
        ocr_needed = excluded.ocr_needed,
        ocr_attempts = excluded.ocr_attempts,
        ocr_last_error_kind = excluded.ocr_last_error_kind,
        ocr_last_error_message = excluded.ocr_last_error_message,
        ocr_yield = excluded.ocr_yield,
        ocr_prompt_version = excluded.ocr_prompt_version,
        evidence_ids_json = excluded.evidence_ids_json,
        updated_at = excluded.updated_at
    `);
    try {
      stmt.run([
        entry.case_id,
        entry.page,
        entry.page_hash ?? null,
        entry.state,
        entry.text_quality_score ?? null,
        JSON.stringify(entry.text_quality_reasons),
        entry.native_text_chars,
        entry.native_text_hash ?? null,
        entry.piece_type,
        entry.piece_confidence ?? null,
        entry.ocr_needed ? 1 : 0,
        entry.ocr_attempts,
        entry.ocr_last_error_kind ?? null,
        entry.ocr_last_error_message ?? null,
        entry.ocr_yield ?? null,
        entry.ocr_prompt_version ?? null,
        JSON.stringify(entry.evidence_ids),
        entry.updated_at,
      ]);
      this.opened.flush();
    } finally {
      stmt.free();
    }
  }

  listPages(caseId: string): PageLedgerEntry[] {
    const stmt = this.opened.db.prepare(`
      SELECT *
      FROM page_ledger
      WHERE case_id = ?
      ORDER BY page ASC
    `);
    try {
      const rows: PageLedgerEntry[] = [];
      stmt.bind([caseId]);
      while (stmt.step()) rows.push(this.rowToPage(stmt.getAsObject()));
      return rows;
    } finally {
      stmt.free();
    }
  }

  /** Grava o total REAL de páginas do PDF (denominador autoritativo). */
  setTotalPages(jobId: string, totalPages: number): void {
    const stmt = this.opened.db.prepare(
      "UPDATE ingest_jobs SET total_pages = ? WHERE job_id = ?",
    );
    try {
      stmt.run([Math.max(0, Math.floor(totalPages)), jobId]);
      this.opened.flush();
    } finally {
      stmt.free();
    }
  }

  addOcrTokens(jobId: string, entrada: number, saida: number): void {
    if (!entrada && !saida) return;
    const stmt = this.opened.db.prepare(`
      UPDATE ingest_jobs
      SET ocr_tokens_in = COALESCE(ocr_tokens_in, 0) + ?,
          ocr_tokens_out = COALESCE(ocr_tokens_out, 0) + ?
      WHERE job_id = ?
    `);
    try {
      stmt.run([Math.floor(entrada), Math.floor(saida), jobId]);
      this.opened.flush();
    } finally {
      stmt.free();
    }
  }

  summarizeStatus(caseId: string): CaseStatus {
    const jobRow = this.getLatestJobRow(caseId);
    const pages = this.listPages(caseId);
    const processedPages = pages.filter((page) => PROCESSED_STATES.has(page.state)).length;
    const needsOcrPages = pages
      .filter((page) => NEEDS_OCR_STATES.has(page.state))
      .map((page) => page.page);
    return {
      case_id: caseId,
      status: jobRow ? this.rowToJob(jobRow).status : "queued",
      total_pages: Math.max(Number(jobRow?.total_pages ?? 0), pages.length),
      processed_pages: processedPages,
      needs_ocr_pages: needsOcrPages,
      alerts: jobRow ? this.rowToJob(jobRow).alerts : [],
      ocr_tokens: jobRow
        ? (() => {
            const job = this.rowToJob(jobRow);
            return job.ocr_tokens_in || job.ocr_tokens_out
              ? { entrada: job.ocr_tokens_in ?? 0, saida: job.ocr_tokens_out ?? 0 }
              : undefined;
          })()
        : undefined,
    };
  }

  writeSnapshots(caseId: string): void {
    const caseDir = dirname(this.artifactsDir);
    const status = this.summarizeStatus(caseId);
    const job = this.getLatestJob(caseId);
    const pages = this.listPages(caseId);
    mkdirSync(this.artifactsDir, { recursive: true });
    writeFileSync(join(caseDir, "status.json"), JSON.stringify(status, null, 2));
    if (job) {
      writeFileSync(join(this.artifactsDir, "ingest_job.json"), JSON.stringify(job, null, 2));
    }
    writeFileSync(
      join(this.artifactsDir, "page_ledger.snapshot.json"),
      JSON.stringify(pages, null, 2),
    );
  }

  setOcrEstimate(caseId: string, estimate: OcrEstimate): void {
    const now = new Date().toISOString();
    const stmt = this.opened.db.prepare(`
      INSERT INTO ocr_approvals (
        case_id, pages, calls, requires_approval, approved, max_pages, max_calls, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_id) DO UPDATE SET
        pages = excluded.pages,
        calls = excluded.calls,
        requires_approval = excluded.requires_approval,
        approved = excluded.approved,
        max_pages = excluded.max_pages,
        max_calls = excluded.max_calls,
        updated_at = excluded.updated_at
    `);
    try {
      stmt.run([
        caseId,
        estimate.pages,
        estimate.calls,
        estimate.requires_approval ? 1 : 0,
        estimate.approved ? 1 : 0,
        estimate.max_pages ?? null,
        estimate.max_calls ?? null,
        now,
      ]);
      this.opened.flush();
    } finally {
      stmt.free();
    }

    const latest = this.getLatestJob(caseId);
    if (latest) {
      this.updateJob(latest.job_id, {
        status:
          estimate.requires_approval && !estimate.approved
            ? "paused_awaiting_ocr_approval"
            : latest.status,
        updated_at: now,
        ocr_estimate: estimate,
      });
    }
  }

  getOcrEstimate(caseId: string): OcrEstimate {
    const stmt = this.opened.db.prepare(`
      SELECT *
      FROM ocr_approvals
      WHERE case_id = ?
    `);
    try {
      stmt.bind([caseId]);
      if (!stmt.step()) {
        return { pages: 0, calls: 0, requires_approval: false, approved: true };
      }
      return this.rowToOcrEstimate(stmt.getAsObject());
    } finally {
      stmt.free();
    }
  }

  authorizeOcr(
    caseId: string,
    limits: { max_pages: number; max_calls: number },
  ): OcrEstimate {
    const current = this.getOcrEstimate(caseId);
    const approved: OcrEstimate = {
      ...current,
      approved: true,
      max_pages: limits.max_pages,
      max_calls: limits.max_calls,
    };
    this.setOcrEstimate(caseId, approved);
    const latest = this.getLatestJob(caseId);
    if (latest) {
      this.updateJob(latest.job_id, {
        status: "running",
        updated_at: new Date().toISOString(),
        ocr_estimate: approved,
      });
    }
    return approved;
  }

  writeCoverageSnapshot(caseId: string, manifest: CoverageManifest): void {
    mkdirSync(this.artifactsDir, { recursive: true });
    writeFileSync(
      join(this.artifactsDir, "coverage_manifest.json"),
      JSON.stringify({ ...manifest, case_id: caseId }, null, 2),
    );
  }

  close(): void {
    this.opened.close();
  }

  private initSchema(): void {
    this.opened.db.run(`
      CREATE TABLE IF NOT EXISTS ingest_jobs (
        job_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        heartbeat_deadline_ms INTEGER NOT NULL,
        total_pages INTEGER NOT NULL DEFAULT 0,
        lock_owner TEXT,
        lock_acquired_at TEXT,
        last_heartbeat_at TEXT,
        worker_pid INTEGER,
        alerts_json TEXT NOT NULL DEFAULT '[]',
        ocr_estimate_json TEXT
      );
    `);
    this.opened.db.run(`
      CREATE TABLE IF NOT EXISTS page_ledger (
        case_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        page_hash TEXT,
        state TEXT NOT NULL,
        text_quality_score REAL,
        text_quality_reasons_json TEXT NOT NULL DEFAULT '[]',
        native_text_chars INTEGER NOT NULL DEFAULT 0,
        native_text_hash TEXT,
        piece_type TEXT NOT NULL DEFAULT 'unknown',
        piece_confidence REAL,
        ocr_needed INTEGER NOT NULL DEFAULT 0,
        ocr_attempts INTEGER NOT NULL DEFAULT 0,
        ocr_last_error_kind TEXT,
        ocr_last_error_message TEXT,
        ocr_yield TEXT,
        ocr_prompt_version INTEGER,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (case_id, page)
      );
    `);
    // Bancos criados antes da v0.6.1 não têm as colunas de rendimento de OCR.
    this.ensureColumn("page_ledger", "ocr_yield", "TEXT");
    this.ensureColumn("page_ledger", "ocr_prompt_version", "INTEGER");
    // v0.9.3: tokens reais de OCR acumulados no job (custo BYOK visível).
    this.ensureColumn("ingest_jobs", "ocr_tokens_in", "INTEGER");
    this.ensureColumn("ingest_jobs", "ocr_tokens_out", "INTEGER");
    this.opened.db.run(`
      CREATE TABLE IF NOT EXISTS ocr_approvals (
        case_id TEXT PRIMARY KEY,
        pages INTEGER NOT NULL DEFAULT 0,
        calls INTEGER NOT NULL DEFAULT 0,
        requires_approval INTEGER NOT NULL DEFAULT 0,
        approved INTEGER NOT NULL DEFAULT 1,
        max_pages INTEGER,
        max_calls INTEGER,
        updated_at TEXT NOT NULL
      );
    `);
    this.opened.flush();
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const stmt = this.opened.db.prepare(`PRAGMA table_info(${table})`);
    try {
      while (stmt.step()) {
        if (String(stmt.getAsObject().name) === column) return;
      }
    } finally {
      stmt.free();
    }
    this.opened.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  private getJobRow(jobId: string): JobRow | undefined {
    const stmt = this.opened.db.prepare(`
      SELECT *
      FROM ingest_jobs
      WHERE job_id = ?
    `);
    try {
      stmt.bind([jobId]);
      if (!stmt.step()) return undefined;
      return stmt.getAsObject() as JobRow;
    } finally {
      stmt.free();
    }
  }

  private getLatestJobRow(caseId: string): JobRow | undefined {
    const stmt = this.opened.db.prepare(`
      SELECT *
      FROM ingest_jobs
      WHERE case_id = ?
      ORDER BY created_at DESC, job_id DESC
      LIMIT 1
    `);
    try {
      stmt.bind([caseId]);
      if (!stmt.step()) return undefined;
      return stmt.getAsObject() as JobRow;
    } finally {
      stmt.free();
    }
  }

  private rowToJob(row: JobRow): IngestJob {
    return {
      job_id: String(row.job_id),
      case_id: String(row.case_id),
      status: row.status as IngestJob["status"],
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      heartbeat_deadline_ms: Number(row.heartbeat_deadline_ms),
      lock_owner: row.lock_owner ? String(row.lock_owner) : undefined,
      lock_acquired_at: row.lock_acquired_at ? String(row.lock_acquired_at) : undefined,
      last_heartbeat_at: row.last_heartbeat_at ? String(row.last_heartbeat_at) : undefined,
      worker_pid: row.worker_pid ? Number(row.worker_pid) : undefined,
      alerts: parseJsonArray(row.alerts_json),
      ocr_tokens_in: row.ocr_tokens_in == null ? undefined : Number(row.ocr_tokens_in),
      ocr_tokens_out: row.ocr_tokens_out == null ? undefined : Number(row.ocr_tokens_out),
      ocr_estimate:
        typeof row.ocr_estimate_json === "string" && row.ocr_estimate_json.length
          ? JSON.parse(row.ocr_estimate_json)
          : undefined,
    };
  }

  private rowToPage(row: Record<string, unknown>): PageLedgerEntry {
    return {
      case_id: String(row.case_id),
      page: Number(row.page),
      page_hash: row.page_hash ? String(row.page_hash) : undefined,
      state: row.state as PageLedgerEntry["state"],
      text_quality_score:
        typeof row.text_quality_score === "number" ? row.text_quality_score : undefined,
      text_quality_reasons: parseJsonArray(row.text_quality_reasons_json),
      native_text_chars: Number(row.native_text_chars),
      native_text_hash: row.native_text_hash ? String(row.native_text_hash) : undefined,
      piece_type: row.piece_type as PageLedgerEntry["piece_type"],
      piece_confidence:
        typeof row.piece_confidence === "number" ? row.piece_confidence : undefined,
      ocr_needed: Number(row.ocr_needed) === 1,
      ocr_attempts: Number(row.ocr_attempts),
      ocr_last_error_kind: row.ocr_last_error_kind ? String(row.ocr_last_error_kind) : undefined,
      ocr_last_error_message: row.ocr_last_error_message
        ? String(row.ocr_last_error_message)
        : undefined,
      ocr_yield: row.ocr_yield ? (String(row.ocr_yield) as PageLedgerEntry["ocr_yield"]) : undefined,
      ocr_prompt_version:
        row.ocr_prompt_version == null ? undefined : Number(row.ocr_prompt_version),
      evidence_ids: parseJsonArray(row.evidence_ids_json),
      updated_at: String(row.updated_at),
    };
  }

  private rowToOcrEstimate(row: Record<string, unknown>): OcrEstimate {
    const maxPages = row.max_pages == null ? undefined : Number(row.max_pages);
    const maxCalls = row.max_calls == null ? undefined : Number(row.max_calls);
    return {
      pages: Number(row.pages),
      calls: Number(row.calls),
      requires_approval: Number(row.requires_approval) === 1,
      approved: Number(row.approved) === 1,
      max_pages: Number.isFinite(maxPages) ? maxPages : undefined,
      max_calls: Number.isFinite(maxCalls) ? maxCalls : undefined,
    };
  }
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.length) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}
