import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseManifest, CaseStatus } from "../domain/types.js";
import { CaseJobStore } from "../jobs/job-store.js";
import {
  type CreateCaseJobResult,
  type OcrRuntimeOptions,
  runIngestJob,
  startIngestJobInBackground,
} from "../jobs/worker-runner.js";
import { createWorkspace } from "../storage/workspace.js";

export type IngestStartMode = "inline" | "background";

export interface IngestCaseOptions {
  startMode?: IngestStartMode;
  geminiApiKey?: string;
  ocr?: OcrRuntimeOptions;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export async function createCaseJob(
  root: string,
  pdfPath: string,
  slug?: string,
  options: IngestCaseOptions = {},
): Promise<CreateCaseJobResult> {
  const ws = createWorkspace(root, pdfPath, slug);
  const now = new Date().toISOString();
  const manifest: CaseManifest = {
    case_id: ws.caseId,
    area: "civil",
    source_pdf: ws.paths.sourcePdf,
    created_at: now,
  };
  writeJson(ws.paths.manifest, manifest);

  const store = await CaseJobStore.open(ws.paths.db, ws.root, ws.paths.artifactsDir);
  const job = store.createJob(ws.caseId, 0, now);
  store.writeSnapshots(ws.caseId);
  store.close();

  const result: CreateCaseJobResult = {
    case_id: ws.caseId,
    job_id: job.job_id,
    status: job.status,
    message:
      options.startMode === "background"
        ? "ingestao iniciada em background"
        : "ingestao iniciada localmente",
  };

  if (options.startMode === "background") {
    startIngestJobInBackground({
      root: ws.root,
      caseId: ws.caseId,
      geminiApiKey: options.geminiApiKey,
      heartbeatDeadlineMs: job.heartbeat_deadline_ms,
      ocr: options.ocr,
    });
  } else {
    const run = await runIngestJob({
      root: ws.root,
      caseId: ws.caseId,
      geminiApiKey: options.geminiApiKey,
      heartbeatDeadlineMs: job.heartbeat_deadline_ms,
      ocr: options.ocr,
    });
    result.status = run.status;
  }

  return result;
}

export async function ingestCase(
  root: string,
  pdfPath: string,
  slug?: string,
  options: IngestCaseOptions = {},
): Promise<{ case_id: string; status: CaseStatus }> {
  const created = await createCaseJob(root, pdfPath, slug, {
    ...options,
    startMode: options.startMode ?? "inline",
  });
  const status = readJson<CaseStatus>(join(root, created.case_id, "status.json"));
  return {
    case_id: created.case_id,
    status,
  };
}
