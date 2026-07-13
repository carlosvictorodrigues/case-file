import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CaseJobStore } from "../src/jobs/job-store.js";
import type { PageLedgerEntry } from "../src/domain/types.js";

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpCase() {
  const root = mkdtempSync(join(tmpdir(), "case-job-"));
  dirs.push(root);
  const artifactsDir = join(root, "caso", "artifacts");
  return {
    root,
    dbPath: join(root, "caso", "index", "case.sqlite"),
    artifactsDir,
  };
}

function page(page: number, state: PageLedgerEntry["state"]): PageLedgerEntry {
  return {
    case_id: "caso",
    page,
    state,
    text_quality_reasons: [],
    native_text_chars: 120,
    piece_type: "unknown",
    ocr_needed: false,
    ocr_attempts: 0,
    evidence_ids: [`case:caso:page:${page}:unit:p001`],
    updated_at: "2026-07-07T20:00:00.000Z",
  };
}

describe("CaseJobStore", () => {
  it("creates jobs and upserts page ledger rows in SQLite", async () => {
    const c = tmpCase();
    const store = await CaseJobStore.open(c.dbPath, c.root, c.artifactsDir);
    const job = store.createJob("caso", 2, "2026-07-07T20:00:00.000Z");

    store.upsertPage(page(1, "done"));
    store.upsertPage(page(2, "ocr_needed"));
    store.close();

    const reopened = await CaseJobStore.open(c.dbPath, c.root, c.artifactsDir);
    expect(reopened.getJob(job.job_id)).toMatchObject({
      case_id: "caso",
      status: "queued",
    });
    expect(reopened.listPages("caso").map((row) => row.state)).toEqual([
      "done",
      "ocr_needed",
    ]);
    reopened.close();
  });

  it("writes status and page ledger snapshots derived from SQLite", async () => {
    const c = tmpCase();
    const store = await CaseJobStore.open(c.dbPath, c.root, c.artifactsDir);
    store.createJob("caso", 1, "2026-07-07T20:00:00.000Z");
    store.upsertPage(page(1, "done"));

    store.writeSnapshots("caso");
    store.close();

    const statusPath = join(c.root, "caso", "status.json");
    const snapshotPath = join(c.artifactsDir, "page_ledger.snapshot.json");
    expect(existsSync(statusPath)).toBe(true);
    expect(JSON.parse(readFileSync(statusPath, "utf8"))).toMatchObject({
      case_id: "caso",
      status: "queued",
      total_pages: 1,
      processed_pages: 1,
    });
    expect(JSON.parse(readFileSync(snapshotPath, "utf8"))[0]).toMatchObject({
      page: 1,
      state: "done",
    });
  });
});
