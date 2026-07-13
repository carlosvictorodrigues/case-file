import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CaseJobStore } from "../src/jobs/job-store.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("OCR approval", () => {
  it("requires approval for large OCR batches and stores limits", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocr-approval-"));
    dirs.push(root);
    const caseDir = join(root, "caso");
    const store = await CaseJobStore.open(join(caseDir, "index", "case.sqlite"), root, join(caseDir, "artifacts"));
    const job = store.createJob("caso", 500, "2026-07-07T20:00:00.000Z");

    store.setOcrEstimate("caso", { pages: 312, calls: 312, requires_approval: true, approved: false });
    expect(store.getLatestJob("caso")).toMatchObject({ status: "paused_awaiting_ocr_approval" });

    const approved = store.authorizeOcr("caso", { max_pages: 500, max_calls: 500 });
    expect(approved).toMatchObject({ approved: true, max_pages: 500, max_calls: 500 });
    expect(store.getJob(job.job_id)).toMatchObject({ status: "running" });
    store.close();
  });
});
