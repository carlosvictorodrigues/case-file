import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseManifest, CaseStatus } from "../domain/types.js";
import { countPdfPages } from "./pdf-text.js";
import { CaseJobStore } from "../jobs/job-store.js";
import {
  type CreateCaseJobResult,
  type OcrRuntimeOptions,
  runIngestJob,
  startIngestJobInBackground,
} from "../jobs/worker-runner.js";
import { createWorkspace } from "../storage/workspace.js";
import { existsSync, readdirSync } from "node:fs";

export type IngestStartMode = "inline" | "background";

export interface IngestCaseOptions {
  startMode?: IngestStartMode;
  geminiApiKey?: string;
  /** Área do processo; define eixos do quadro e a tabela de prazos. */
  area?: "civil" | "penal";
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
  // Denominador autoritativo desde o nascimento do caso: o total REAL do
  // PDF. Se a contagem falhar (PDF corrompido etc.), 0 + self-heal na
  // retomada — mas nunca "descobertas == total" fingindo completude.
  let totalPagesPdf = 0;
  try {
    totalPagesPdf = await countPdfPages(ws.paths.sourcePdf);
  } catch {
    // processCase reconta e grava; criar o caso não pode falhar por isso.
  }
  const manifest: CaseManifest = {
    case_id: ws.caseId,
    area: options.area ?? "civil",
    source_pdf: ws.paths.sourcePdf,
    created_at: now,
    total_pages_pdf: totalPagesPdf || undefined,
  };
  writeJson(ws.paths.manifest, manifest);

  const store = await CaseJobStore.open(ws.paths.db, ws.root, ws.paths.artifactsDir);
  const job = store.createJob(ws.caseId, totalPagesPdf, now);
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

/** Mesmo fator do worker-lock/status: morte declarada após 4× o deadline. */
const BOOT_STALE_MULTIPLIER = 4;

export interface InterruptedCase {
  case_id: string;
  status: string;
}

/**
 * Casos com ingestão interrompida (worker morto no meio) ou em erro — os que
 * uma retomada resolve sozinha. NUNCA inclui paused_awaiting_ocr_approval:
 * gate de custo é decisão do usuário, não de boot.
 */
export function findInterruptedCases(root: string): InterruptedCase[] {
  const out: InterruptedCase[] = [];
  if (!existsSync(root)) return out;
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith("_")) continue;
    const caseDir = join(root, dirent.name);
    const statusPath = join(caseDir, "status.json");
    if (!existsSync(join(caseDir, "case.json")) || !existsSync(statusPath)) continue;
    try {
      const status = JSON.parse(readFileSync(statusPath, "utf8")) as CaseStatus;
      if (status.status === "error") {
        out.push({ case_id: dirent.name, status: status.status });
        continue;
      }
      if (status.status !== "running" && status.status !== "queued") continue;
      const jobPath = join(caseDir, "artifacts", "ingest_job.json");
      if (!existsSync(jobPath)) continue;
      const job = JSON.parse(readFileSync(jobPath, "utf8")) as {
        last_heartbeat_at?: string;
        heartbeat_deadline_ms?: number;
      };
      if (!job.last_heartbeat_at) continue;
      const idade = Date.now() - Date.parse(job.last_heartbeat_at);
      if (idade > (job.heartbeat_deadline_ms ?? 30_000) * BOOT_STALE_MULTIPLIER) {
        out.push({ case_id: dirent.name, status: status.status });
      }
    } catch {
      // status ilegível não derruba o boot; o caso fica para triagem manual.
    }
  }
  return out;
}

/**
 * Retomada automática no boot do servidor: o host (Claude Desktop) mata o
 * processo da extensão quando quer — cada novo boot recomeça de onde parou,
 * sem depender de ninguém chamar retomar_ingestao (achado de campo: worker
 * morto externamente a ~10min deixava caderno grande sem saída).
 */
export function autoResumeInterruptedCases(
  root: string,
  options: { geminiApiKey?: string; ocr?: OcrRuntimeOptions } = {},
): string[] {
  const interrupted = findInterruptedCases(root);
  for (const item of interrupted) {
    startIngestJobInBackground({
      root,
      caseId: item.case_id,
      geminiApiKey: options.geminiApiKey,
      ocr: options.ocr,
    });
  }
  return interrupted.map((item) => item.case_id);
}

