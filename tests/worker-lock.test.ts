import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireWorkerLease, isLeaseLive, renewWorkerLease } from "../src/jobs/worker-lock.js";
import { CaseJobStore } from "../src/jobs/job-store.js";

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "case-lock-"));
  dirs.push(root);
  const caseDir = join(root, "caso");
  const artifactsDir = join(caseDir, "artifacts");
  const store = await CaseJobStore.open(join(caseDir, "index", "case.sqlite"), root, artifactsDir);
  const job = store.createJob("caso", 1, "2026-07-07T20:00:00.000Z");
  return { root, caseDir, store, job };
}

describe("worker lock", () => {
  it("allows only one live worker lease", async () => {
    const s = await setup();
    const first = acquireWorkerLease({
      caseDir: s.caseDir,
      store: s.store,
      jobId: s.job.job_id,
      now: "2026-07-07T20:00:00.000Z",
      heartbeatDeadlineMs: 30000,
    });
    const second = acquireWorkerLease({
      caseDir: s.caseDir,
      store: s.store,
      jobId: s.job.job_id,
      now: "2026-07-07T20:00:10.000Z",
      heartbeatDeadlineMs: 30000,
    });

    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({ acquired: false, reason: "worker_lock_live" });
    expect(existsSync(join(s.caseDir, "case.lock"))).toBe(true);
    s.store.close();
  });

  it("reclaims an expired lease and renews heartbeat", async () => {
    const s = await setup();
    const first = acquireWorkerLease({
      caseDir: s.caseDir,
      store: s.store,
      jobId: s.job.job_id,
      now: "2026-07-07T20:00:00.000Z",
      heartbeatDeadlineMs: 1000,
    });
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error("expected first lease");

    const reclaimed = acquireWorkerLease({
      caseDir: s.caseDir,
      store: s.store,
      jobId: s.job.job_id,
      now: "2026-07-07T20:00:02.000Z",
      heartbeatDeadlineMs: 1000,
    });
    expect(reclaimed.acquired).toBe(true);
    if (!reclaimed.acquired) throw new Error("expected reclaimed lease");
    expect(reclaimed.lock_owner).not.toBe(first.lock_owner);

    renewWorkerLease({
      caseDir: s.caseDir,
      store: s.store,
      jobId: s.job.job_id,
      lockOwner: reclaimed.lock_owner,
      now: "2026-07-07T20:00:02.500Z",
    });
    expect(s.store.getJob(s.job.job_id)?.last_heartbeat_at).toBe("2026-07-07T20:00:02.500Z");
    s.store.close();
  });

  it("does not let a fresh job steal a live lock held by another job", async () => {
    const s = await setup();
    const first = acquireWorkerLease({
      caseDir: s.caseDir,
      store: s.store,
      jobId: s.job.job_id,
      now: "2026-07-07T20:00:00.000Z",
      heartbeatDeadlineMs: 30000,
    });
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error("expected first lease");

    // Um segundo job para o MESMO caso (retry de criar_caso_local): ele não
    // tem heartbeat próprio, mas o lock do job-1 está vivo e deve prevalecer.
    const secondJob = s.store.createJob("caso", 1, "2026-07-07T20:00:05.000Z");
    const thief = acquireWorkerLease({
      caseDir: s.caseDir,
      store: s.store,
      jobId: secondJob.job_id,
      now: "2026-07-07T20:00:10.000Z",
      heartbeatDeadlineMs: 30000,
    });
    expect(thief).toMatchObject({
      acquired: false,
      reason: "worker_lock_live",
      lock_owner: first.lock_owner,
    });
    expect(existsSync(join(s.caseDir, "case.lock"))).toBe(true);
    s.store.close();
  });

  it("uses heartbeat deadline for liveness", () => {
    expect(isLeaseLive("2026-07-07T20:00:00.000Z", 30000, "2026-07-07T20:00:29.000Z")).toBe(true);
    expect(isLeaseLive("2026-07-07T20:00:00.000Z", 30000, "2026-07-07T20:00:31.000Z")).toBe(false);
  });
});
