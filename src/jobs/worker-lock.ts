import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CaseJobStore } from "./job-store.js";

export interface WorkerLeaseInput {
  caseDir: string;
  store: CaseJobStore;
  jobId: string;
  now: string;
  heartbeatDeadlineMs: number;
}

export type WorkerLeaseResult =
  | { acquired: true; lock_owner: string }
  | {
      acquired: false;
      reason: "worker_lock_live";
      lock_owner?: string;
      /** Idade do último heartbeat do dono — p/ mensagem "worker ativo há Xs". */
      heartbeat_age_ms?: number;
    };

/**
 * Margem antes de ROUBAR um lease: o dono só é declarado morto após
 * STALE_LEASE_MULTIPLIER × deadline sem heartbeat. Deadline cru (30s) era
 * menor que fases legítimas sem sinal (incidente caso-3: retomada roubou o
 * lease de um worker VIVO extraindo um PDF grande → "owner mismatch").
 */
export const STALE_LEASE_MULTIPLIER = 4;

interface LockFile {
  lock_owner?: string;
  job_id?: string;
  acquired_at?: string;
}

function lockFilePath(caseDir: string): string {
  return join(caseDir, "case.lock");
}

function readLockFile(lockPath: string): LockFile | undefined {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as LockFile;
  } catch {
    // Ausente ou corrompido: quem chama decide tratar como stale.
    return undefined;
  }
}

export function isLeaseLive(
  lastHeartbeat: string | undefined,
  deadlineMs: number,
  now: string,
): boolean {
  if (!lastHeartbeat) return false;
  return Date.parse(now) - Date.parse(lastHeartbeat) <= deadlineMs;
}

export function acquireWorkerLease(input: WorkerLeaseInput): WorkerLeaseResult {
  const lockPath = lockFilePath(input.caseDir);
  if (existsSync(lockPath)) {
    // A liveness é SEMPRE avaliada pelo job DONO do lock (job_id gravado no
    // arquivo), nunca pelo job adquirente: um job recém-criado ainda não tem
    // heartbeat e enxergaria qualquer lock vivo como morto.
    const lock = readLockFile(lockPath);
    const ownerJob = lock?.job_id ? input.store.getJob(lock.job_id) : undefined;
    const live = ownerJob
      ? isLeaseLive(
          ownerJob.last_heartbeat_at,
          ownerJob.heartbeat_deadline_ms * STALE_LEASE_MULTIPLIER,
          input.now,
        )
      : false;
    if (live) {
      return {
        acquired: false,
        reason: "worker_lock_live",
        lock_owner: lock?.lock_owner ?? ownerJob?.lock_owner,
        heartbeat_age_ms: ownerJob?.last_heartbeat_at
          ? Date.parse(input.now) - Date.parse(ownerJob.last_heartbeat_at)
          : undefined,
      };
    }
    unlinkSync(lockPath);
  }

  const lockOwner = `worker-${randomUUID()}`;
  mkdirSync(input.caseDir, { recursive: true });
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Outro adquirente venceu a corrida entre o unlink e o openSync.
      return {
        acquired: false,
        reason: "worker_lock_live",
        lock_owner: readLockFile(lockPath)?.lock_owner,
      };
    }
    throw error;
  }
  try {
    writeFileSync(
      fd,
      JSON.stringify(
        {
          lock_owner: lockOwner,
          job_id: input.jobId,
          acquired_at: input.now,
        },
        null,
        2,
      ),
    );
  } finally {
    closeSync(fd);
  }

  input.store.updateJob(input.jobId, {
    status: "running",
    updated_at: input.now,
    lock_owner: lockOwner,
    lock_acquired_at: input.now,
    last_heartbeat_at: input.now,
    heartbeat_deadline_ms: input.heartbeatDeadlineMs,
    worker_pid: process.pid,
  });

  return { acquired: true, lock_owner: lockOwner };
}

/**
 * Confirma que este worker ainda é o dono do lock. Deve ser chamado depois de
 * awaits longos (ex.: uma chamada de OCR) e antes de escrever no ledger, para
 * que um worker cujo lease expirou e foi tomado por outro não intercale
 * escritas com o novo dono.
 */
export function ownsLock(caseDir: string, jobId: string, lockOwner: string): boolean {
  const lock = readLockFile(lockFilePath(caseDir));
  return lock?.lock_owner === lockOwner && lock?.job_id === jobId;
}

export function renewWorkerLease(input: {
  caseDir: string;
  store: CaseJobStore;
  jobId: string;
  lockOwner: string;
  now: string;
}): void {
  if (!ownsLock(input.caseDir, input.jobId, input.lockOwner)) {
    throw new Error("Worker lease owner mismatch");
  }
  input.store.updateJob(input.jobId, {
    status: "running",
    updated_at: input.now,
    last_heartbeat_at: input.now,
    lock_owner: input.lockOwner,
    worker_pid: process.pid,
  });
}
