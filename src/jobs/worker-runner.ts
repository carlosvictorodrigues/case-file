import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCoverageManifest } from "../core/coverage.js";
import {
  buildStructuralSummary,
  extractCaseHeaderFacts,
} from "../civil/case-file-facts.js";
import { buildDocumentMap } from "../civil/document-map.js";
import { extractCivilEvents } from "../civil/event-extractor.js";
import { reconcileCivilEvents } from "../civil/event-reconciler.js";
import { classifyCivilPiece } from "../civil/piece-classifier.js";
import { evidenceId, sha256, stableCaseId } from "../domain/evidence.js";
import type {
  CaseManifest,
  EvidenceUnit,
  IngestJobStatus,
  OcrEstimate,
  PageLedgerEntry,
} from "../domain/types.js";
import { countPdfPages, extractPdfTextByPage, type PdfPageText } from "../ingest/pdf-text.js";
import { OCR_PROMPT_VERSION, type GeminiOcrClient } from "../ocr/gemini-client.js";
import { ensureSinglePagePdfInput } from "../ocr/pdf-page-input.js";
import { runOcrForPage, type OcrPageResult } from "../ocr/ocr-service.js";
import { assessOcrYield, assessTextQuality } from "../ocr/text-quality.js";
import { redactSecrets } from "../security/redact.js";
import { CaseIndex } from "../storage/index-db.js";
import { resolveInsideRoot } from "../storage/workspace.js";
import { CaseJobStore } from "./job-store.js";
import { acquireWorkerLease, ownsLock, renewWorkerLease } from "./worker-lock.js";

export interface OcrRuntimeOptions {
  model?: string;
  maxRetryAttempts?: number;
  approvalPageThreshold?: number;
  /** Chamadas de OCR simultâneas (ocr_max_concurrency do manifest). */
  maxConcurrency?: number;
  /** Injetável em teste; produção usa o cliente HTTP real. */
  client?: GeminiOcrClient;
}

export interface CreateCaseJobResult {
  case_id: string;
  job_id: string;
  status: IngestJobStatus;
  message: string;
}

export interface RunIngestJobInput {
  root: string;
  caseId: string;
  geminiApiKey?: string;
  heartbeatDeadlineMs?: number;
  ocr?: OcrRuntimeOptions;
}

export interface ResumeIngestResult {
  case_id: string;
  job_id: string;
  status: IngestJobStatus;
  resumed: boolean;
  lock_owner?: string;
  reason?: "worker_lock_live";
  heartbeat_age_ms?: number;
}

interface CaseRunnerPaths {
  caseId: string;
  caseDir: string;
  pagesDir: string;
  artifactsDir: string;
  db: string;
  manifest: string;
}

const DEFAULT_OCR_RETRY_ATTEMPTS = 3;
const DEFAULT_OCR_APPROVAL_PAGE_THRESHOLD = 25;
const OCR_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_OCR_CONCURRENCY = 2;
const MAX_OCR_CONCURRENCY = 32;
const SNAPSHOT_EVERY_PAGES = 10;

/** Estados que não precisam de reprocessamento quando o texto nativo não mudou. */
const RESUME_SKIP_STATES = new Set<PageLedgerEntry["state"]>([
  "done",
  "ocr_done",
  "failed_permanent",
]);

/** Estados que entram na fila de OCR da fase B (texto nativo inutilizável). */
export const OCR_QUEUE_STATES = new Set<PageLedgerEntry["state"]>([
  "ocr_needed",
  "skipped_no_key",
  "failed_retryable",
]);

class LeaseLostError extends Error {
  constructor() {
    super("Worker lease lost during ingest");
  }
}

export function startIngestJobInBackground(input: RunIngestJobInput): void {
  setImmediate(() => {
    void runIngestJob(input).catch(() => {
      // Status is persisted by runIngestJob; avoid leaking page text into logs.
    });
  });
}

export async function resumeIngestJob(input: RunIngestJobInput): Promise<ResumeIngestResult> {
  return runIngestJob(input);
}

export async function runIngestJob(input: RunIngestJobInput): Promise<ResumeIngestResult> {
  const paths = caseRunnerPaths(input.root, input.caseId);
  const store = await CaseJobStore.open(paths.db, input.root, paths.artifactsDir);
  try {
    const job = store.getLatestJob(paths.caseId);
    if (!job) {
      throw new Error(`No ingest job found for case_id: ${paths.caseId}`);
    }
    if (job.status === "done") {
      // "done" com páginas ainda na fila de OCR (ex.: ingeriu sem chave e a
      // chave passou a existir) DEVE retomar; done sem pendência é terminal.
      // Página OCRizada com prompt ANTIGO ainda não avaliada pelo prompt atual
      // também reabre a retomada (candidata a re-OCR se rendeu só carimbos).
      const entries = store.listPages(paths.caseId);
      const hasPendingOcr = entries.some((entry) => OCR_QUEUE_STATES.has(entry.state));
      const hasStaleOcrPrompt = entries.some(
        (entry) =>
          entry.state === "ocr_done" && (entry.ocr_prompt_version ?? 1) < OCR_PROMPT_VERSION,
      );
      if (!hasPendingOcr && !hasStaleOcrPrompt) {
        return { case_id: paths.caseId, job_id: job.job_id, status: "done", resumed: false };
      }
    }

    const now = new Date().toISOString();
    const lease = acquireWorkerLease({
      caseDir: paths.caseDir,
      store,
      jobId: job.job_id,
      now,
      heartbeatDeadlineMs: input.heartbeatDeadlineMs ?? job.heartbeat_deadline_ms,
    });
    if (!lease.acquired) {
      return {
        case_id: paths.caseId,
        job_id: job.job_id,
        status: job.status,
        resumed: false,
        reason: lease.reason,
        lock_owner: lease.lock_owner,
        heartbeat_age_ms: lease.heartbeat_age_ms,
      };
    }

    try {
      const status = await processCase(input, paths, store, job.job_id, lease.lock_owner);
      return {
        case_id: paths.caseId,
        job_id: job.job_id,
        status,
        resumed: true,
        lock_owner: lease.lock_owner,
      };
    } catch (error) {
      if (error instanceof LeaseLostError) {
        // Outro worker assumiu o caso; ele é o dono do estado a partir daqui.
        return {
          case_id: paths.caseId,
          job_id: job.job_id,
          status: store.getJob(job.job_id)?.status ?? "running",
          resumed: false,
          reason: "worker_lock_live",
        };
      }
      const current = store.getJob(job.job_id);
      const message =
        error instanceof Error
          ? redactSecrets(error.message, [input.geminiApiKey])
          : "Erro durante ingestao local.";
      store.updateJob(job.job_id, {
        status: "error",
        updated_at: new Date().toISOString(),
        alerts: [...(current?.alerts ?? []), message],
      });
      store.writeSnapshots(paths.caseId);
      throw error;
    } finally {
      releaseLock(paths.caseDir, lease.lock_owner);
    }
  } finally {
    store.close();
  }
}

/** Renova o lease; se outro worker assumiu, sai como takeover (não como erro). */
function renewOrLoseLease(input: {
  caseDir: string;
  store: CaseJobStore;
  jobId: string;
  lockOwner: string;
}): void {
  if (!ownsLock(input.caseDir, input.jobId, input.lockOwner)) {
    throw new LeaseLostError();
  }
  renewWorkerLease({ ...input, now: new Date().toISOString() });
}

/** Heartbeat/snapshot no máximo a cada N ms durante fases longas. */
const HEARTBEAT_EVERY_MS = 10_000;

async function processCase(
  input: RunIngestJobInput,
  paths: CaseRunnerPaths,
  store: CaseJobStore,
  jobId: string,
  lockOwner: string,
): Promise<IngestJobStatus> {
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as CaseManifest;

  // Denominador AUTORITATIVO: o total real de páginas do PDF, nunca "quantas
  // páginas já descobri". Self-heal para casos criados antes da v1.0.1.
  let totalPagesPdf = manifest.total_pages_pdf;
  if (!totalPagesPdf) {
    totalPagesPdf = await countPdfPages(manifest.source_pdf);
    writeFileSync(
      paths.manifest,
      JSON.stringify({ ...manifest, total_pages_pdf: totalPagesPdf }, null, 2) + "\n",
    );
  }
  store.setTotalPages(jobId, totalPagesPdf);
  store.writeSnapshots(paths.caseId);

  // A extração do PDF inteiro pode levar MINUTOS num caderno grande — sem
  // heartbeat aqui o worker vivo parecia morto e a retomada roubava o lease
  // (a causa raiz do "owner mismatch" de campo).
  let lastBeat = Date.now();
  const pages = await extractPdfTextByPage(manifest.source_pdf, {
    onPage: () => {
      if (Date.now() - lastBeat < HEARTBEAT_EVERY_MS) return;
      lastBeat = Date.now();
      renewOrLoseLease({ caseDir: paths.caseDir, store, jobId, lockOwner });
      store.writeSnapshots(paths.caseId);
    },
  });
  const index = await CaseIndex.open(paths.db, input.root);
  try {
    extractPhase(input, paths, store, index, jobId, lockOwner, pages);

    const estimate = settleOcrEstimate(input, store, paths.caseId);
    const ocrAlerts =
      input.geminiApiKey && estimate.approved
        ? await ocrPhase(input, paths, store, index, jobId, lockOwner, pages, estimate, manifest.source_pdf)
        : [];

    return finalizeJob(store, paths, totalPagesPdf, pages.length, ocrAlerts, index);
  } finally {
    index.close();
  }
}

/**
 * Fase A — extração nativa, classificação e ledger. Nunca chama a rede.
 * Páginas já processadas em runs anteriores (mesmo hash de texto nativo)
 * são puladas: retomar uma ingestão não repete trabalho nem custo.
 */
function extractPhase(
  input: RunIngestJobInput,
  paths: CaseRunnerPaths,
  store: CaseJobStore,
  index: CaseIndex,
  jobId: string,
  lockOwner: string,
  pages: PdfPageText[],
): void {
  const existing = new Map(store.listPages(paths.caseId).map((entry) => [entry.page, entry]));

  // Throttle: renovar lease + snapshot por PÁGINA era O(n²) de I/O num
  // caderno de milhares de páginas (cada flush regrava o banco inteiro).
  let lastBeat = 0;
  let snapshotDue = false;
  for (const page of pages) {
    if (Date.now() - lastBeat >= HEARTBEAT_EVERY_MS) {
      lastBeat = Date.now();
      snapshotDue = true;
      renewOrLoseLease({ caseDir: paths.caseDir, store, jobId, lockOwner });
    }

    const nativeHash = sha256(page.text);
    const prior = existing.get(page.page);
    if (prior && prior.native_text_hash === nativeHash && RESUME_SKIP_STATES.has(prior.state)) {
      maybeRequeueStampOnlyOcr(input, paths, store, prior);
      continue;
    }

    const pagePath = join(paths.pagesDir, pageFileName(page.page));
    writeFileSync(pagePath, page.text, "utf8");
    const quality = assessTextQuality(page.text);
    const needsOcr = page.needs_ocr || quality.needs_ocr;
    const piece = classifyCivilPiece({
      page: page.page,
      text: page.text,
      textReliable: !needsOcr,
    });
    const unit = pageToUnit(paths.caseId, page.page, page.text);
    index.upsertEvidence([unit]);

    let state: PageLedgerEntry["state"] = "done";
    if (needsOcr) {
      state = input.geminiApiKey ? "ocr_needed" : "skipped_no_key";
    }

    store.upsertPage({
      case_id: paths.caseId,
      page: page.page,
      page_hash: nativeHash,
      state,
      text_quality_score: quality.score,
      text_quality_reasons: quality.reasons,
      native_text_chars: page.text.length,
      native_text_hash: nativeHash,
      piece_type: piece.piece_type,
      piece_confidence: piece.piece_confidence,
      ocr_needed: needsOcr,
      ocr_attempts: 0,
      evidence_ids: [unit.evidence_id],
      updated_at: new Date().toISOString(),
    });
    if (snapshotDue) {
      // Snapshot acompanha o heartbeat (~a cada 10s): progresso visível sem
      // regravar o ledger inteiro a cada página.
      snapshotDue = false;
      store.writeSnapshots(paths.caseId);
    }
  }
  store.writeSnapshots(paths.caseId);
}

/**
 * Falso-sucesso de OCR: página `ocr_done` cuja transcrição só trouxe os
 * carimbos digitais do PJe (o modelo pulou a foto/manuscrito — achado de
 * campo caso-2, 40/181 págs). Se o prompt de OCR melhorou desde então,
 * re-enfileira UMA vez por versão de prompt; se o rendimento era conteúdo
 * de verdade, só registra o veredito para não reavaliar a cada retomada.
 */
function maybeRequeueStampOnlyOcr(
  input: RunIngestJobInput,
  paths: CaseRunnerPaths,
  store: CaseJobStore,
  prior: PageLedgerEntry,
): void {
  if (prior.state !== "ocr_done") return;
  const promptVersion = prior.ocr_prompt_version ?? 1;
  if (promptVersion >= OCR_PROMPT_VERSION) return;

  let yieldKind = prior.ocr_yield;
  if (!yieldKind) {
    // Ledger legado (pré-v0.6.1): avalia o artefato .ocr.txt gravado no disco.
    const ocrPath = join(paths.pagesDir, pageFileName(prior.page).replace(/\.txt$/, ".ocr.txt"));
    if (!existsSync(ocrPath)) return;
    yieldKind = assessOcrYield(readFileSync(ocrPath, "utf8")).yield;
  }

  if (yieldKind !== "stamp_only") {
    // Registra veredito E versão avaliada: sem isso, todo retomar_ingestao
    // reabriria o job "done" para reavaliar as mesmas páginas.
    store.upsertPage({
      ...prior,
      ocr_yield: yieldKind,
      ocr_prompt_version: OCR_PROMPT_VERSION,
      updated_at: new Date().toISOString(),
    });
    return;
  }
  store.upsertPage({
    ...prior,
    state: input.geminiApiKey ? "ocr_needed" : "skipped_no_key",
    ocr_needed: true,
    ocr_attempts: 0,
    ocr_yield: "stamp_only",
    updated_at: new Date().toISOString(),
  });
}

/**
 * Consolida a estimativa de OCR ANTES de qualquer chamada Gemini e aplica o
 * gate de aprovação: acima do threshold, só OCRiza com aprovação explícita
 * (autorizar_ocr grava approved + tetos). O default "approved" do banco não
 * vale como consentimento — aprovação explícita sempre carrega tetos.
 */
function settleOcrEstimate(
  input: RunIngestJobInput,
  store: CaseJobStore,
  caseId: string,
): OcrEstimate {
  const pending = store
    .listPages(caseId)
    .filter((entry) => OCR_QUEUE_STATES.has(entry.state));
  const threshold = input.ocr?.approvalPageThreshold ?? DEFAULT_OCR_APPROVAL_PAGE_THRESHOLD;
  const prior = store.getOcrEstimate(caseId);
  const explicitlyApproved = prior.approved === true && prior.max_pages !== undefined;
  const requiresApproval = pending.length > threshold;

  const estimate: OcrEstimate = {
    pages: pending.length,
    calls: pending.length,
    requires_approval: requiresApproval,
    approved: !requiresApproval || explicitlyApproved,
    max_pages: prior.max_pages,
    max_calls: prior.max_calls,
  };
  store.setOcrEstimate(caseId, estimate);
  return estimate;
}

/**
 * Fase B — OCR com tetos autorizados, retry por página, re-checagem de posse
 * e POOL de workers concorrentes (ocr_max_concurrency do manifest). O teto de
 * páginas é reservado no DESPACHO (nunca inicia mais páginas que o aprovado),
 * e as escritas no ledger são seguras porque o event loop as serializa.
 */
async function ocrPhase(
  input: RunIngestJobInput,
  paths: CaseRunnerPaths,
  store: CaseJobStore,
  index: CaseIndex,
  jobId: string,
  lockOwner: string,
  pages: PdfPageText[],
  estimate: OcrEstimate,
  sourcePdf: string,
): Promise<string[]> {
  const alerts: string[] = [];
  const byNumber = new Map(pages.map((page) => [page.page, page]));
  const queue = store.listPages(paths.caseId).filter((entry) => OCR_QUEUE_STATES.has(entry.state));
  const maxPages = estimate.max_pages ?? Number.POSITIVE_INFINITY;
  const maxCalls = estimate.max_calls ?? Number.POSITIVE_INFINITY;
  const concurrency = Math.min(
    Math.max(1, Math.floor(input.ocr?.maxConcurrency ?? DEFAULT_OCR_CONCURRENCY)),
    MAX_OCR_CONCURRENCY,
    Math.max(1, queue.length),
  );

  let nextIndex = 0;
  let pagesStarted = 0;
  let pagesDone = 0;
  let callsMade = 0;
  let tokensEntrada = 0;
  let tokensSaida = 0;
  let sinceSnapshot = 0;
  let capAlerted = false;
  let leaseLost = false;

  const worker = async (): Promise<void> => {
    while (!leaseLost) {
      if (nextIndex >= queue.length) return;
      if (pagesStarted >= maxPages || callsMade >= maxCalls) {
        if (!capAlerted) {
          capAlerted = true;
          alerts.push(
            `Limite autorizado de OCR atingido (${pagesDone} pagina(s), ${callsMade} chamada(s)); use autorizar_ocr para ampliar.`,
          );
        }
        return;
      }
      const entry = queue[nextIndex++];
      const page = byNumber.get(entry.page);
      if (!page) continue;
      pagesStarted++;

      renewWorkerLease({
        caseDir: paths.caseDir,
        store,
        jobId,
        lockOwner,
        now: new Date().toISOString(),
      });

      const { result, attempts, calls } = await ocrPageWithRetry(
        input,
        paths,
        sourcePdf,
        page,
        Math.max(1, maxCalls - callsMade),
      );
      callsMade += calls;
      if (result.tokens) {
        tokensEntrada += result.tokens.entrada;
        tokensSaida += result.tokens.saida;
      }

      // A chamada de OCR pode ter durado mais que o deadline do heartbeat; se
      // outro worker assumiu nesse meio-tempo, não podemos escrever mais nada.
      if (!ownsLock(paths.caseDir, jobId, lockOwner)) {
        leaseLost = true;
        throw new LeaseLostError();
      }

      const evidenceIds = [...entry.evidence_ids.filter((id) => !id.endsWith(":ocr001"))];
      let state: PageLedgerEntry["state"] = result.state;
      let ocrYield = entry.ocr_yield;
      let promptVersion = entry.ocr_prompt_version;
      if (result.evidence) {
        if (result.evidence.source_path && result.evidence.text) {
          writeFileSync(
            join(paths.caseDir, result.evidence.source_path),
            result.evidence.text,
            "utf8",
          );
        }
        index.upsertEvidence([result.evidence]);
        // O texto das evidências da página mudou: vetores antigos (do texto
        // substituído, ou visuais de quando não havia texto) apontariam para
        // conteúdo que não existe mais — o próximo indexar_semantica re-embeda.
        index.deleteVectorsForEvidence([...entry.evidence_ids, result.evidence.evidence_id]);
        evidenceIds.push(result.evidence.evidence_id);
        pagesDone++;
        state = "ocr_done";
        ocrYield = assessOcrYield(result.evidence.text ?? "").yield;
        promptVersion = OCR_PROMPT_VERSION;
      } else if (result.state === "failed_permanent") {
        // Página declarada sem texto: se sobrou vetor textual antigo, remove
        // para que o trilho VISUAL a re-embede.
        index.deleteVectorsForEvidence(entry.evidence_ids);
      }

      store.upsertPage({
        ...entry,
        state,
        ocr_attempts: attempts,
        ocr_last_error_kind: result.error_kind,
        ocr_last_error_message: result.error_message
          ? redactSecrets(result.error_message, [input.geminiApiKey])
          : undefined,
        ocr_yield: ocrYield,
        ocr_prompt_version: promptVersion,
        evidence_ids: evidenceIds,
        updated_at: new Date().toISOString(),
      });
      // Snapshot em lotes: a cada página era O(n²) de serialização num
      // processo grande; o ledger no SQLite continua persistido por página.
      sinceSnapshot++;
      if (sinceSnapshot >= SNAPSHOT_EVERY_PAGES) {
        sinceSnapshot = 0;
        store.writeSnapshots(paths.caseId);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  // Custo REAL acumulado no job (feedback de campo: sem isso o usuário
  // descobre o gasto na fatura do Google).
  store.addOcrTokens(jobId, tokensEntrada, tokensSaida);
  store.writeSnapshots(paths.caseId);
  return alerts;
}

async function ocrPageWithRetry(
  input: RunIngestJobInput,
  paths: CaseRunnerPaths,
  sourcePdf: string,
  page: PdfPageText,
  callBudget: number,
): Promise<{ result: OcrPageResult; attempts: number; calls: number }> {
  const maxAttempts = Math.max(1, input.ocr?.maxRetryAttempts ?? DEFAULT_OCR_RETRY_ATTEMPTS);
  const textRelativePath = `pages/${pageFileName(page.page)}`;
  let attempts = 0;
  let calls = 0;
  let last: OcrPageResult = {
    state: "failed_retryable",
    error_kind: "invalid_response",
    error_message: "OCR nao executado",
  };

  while (attempts < maxAttempts && calls < callBudget) {
    attempts++;
    calls++;
    try {
      const ocrInput = await ensureSinglePagePdfInput({
        sourcePdfPath: sourcePdf,
        pagesDir: paths.pagesDir,
        page: page.page,
      });
      last = await runOcrForPage({
        caseId: paths.caseId,
        page: page.page,
        pageText: page.text,
        pageTextPath: textRelativePath,
        pagePdfPath: ocrInput.relativePath,
        inputBytes: ocrInput.bytes,
        mimeType: ocrInput.mimeType,
        geminiApiKey: input.geminiApiKey,
        model: input.ocr?.model,
        client: input.ocr?.client,
      });
    } catch (error) {
      // Erro de rede/HTTP/parse do Gemini é falha DA PÁGINA, nunca do job.
      last = {
        state: "failed_retryable",
        error_kind: "server_error",
        error_message: redactSecrets(
          error instanceof Error ? error.message : "Falha de OCR desconhecida",
          [input.geminiApiKey],
        ),
      };
    }
    if (last.state === "ocr_done") break;
    if (attempts < maxAttempts && calls < callBudget) {
      await delay(OCR_RETRY_BASE_DELAY_MS * attempts);
    }
  }
  // Transcrição vazia consistente = página sem texto (imagem pura/em branco),
  // não uma falha a re-tentar para sempre. Fica declarada como permanente e
  // segue disponível na busca semântica pelo trilho VISUAL.
  if (
    last.state !== "ocr_done" &&
    attempts >= maxAttempts &&
    last.error_message === "empty OCR transcription"
  ) {
    last = {
      state: "failed_permanent",
      error_kind: "no_text_detected",
      error_message:
        "Pagina sem texto transcritivel (provavelmente imagem ou pagina em branco); disponivel na busca semantica visual.",
    };
  }
  return { result: last, attempts, calls };
}

function finalizeJob(
  store: CaseJobStore,
  paths: CaseRunnerPaths,
  totalPagesPdf: number,
  extractedPages: number,
  ocrAlerts: string[],
  index: CaseIndex,
): IngestJobStatus {
  const ledger = store.listPages(paths.caseId);
  const estimate = store.getOcrEstimate(paths.caseId);
  const coverage = buildCoverageManifest({
    case_id: paths.caseId,
    total_pages: totalPagesPdf,
    pages: ledger,
    ocr_estimate: estimate,
  });
  store.writeCoverageSnapshot(paths.caseId, coverage);

  const pendingOcr = ledger.filter((entry) => OCR_QUEUE_STATES.has(entry.state)).length;
  const pendingAlert = pendingOcr
    ? [`${pendingOcr} pagina(s) precisam de OCR para leitura confiavel.`]
    : [];
  const alerts = [...pendingAlert, ...ocrAlerts, ...coverage.warnings];
  // Cinto e suspensório: se a extração devolveu menos páginas que o PDF tem,
  // o caso NÃO fecha como done — done truncado é a mentira que este release
  // elimina.
  if (extractedPages < totalPagesPdf) {
    alerts.push(
      `Extracao incompleta: ${extractedPages} de ${totalPagesPdf} pagina(s). Retome a ingestao.`,
    );
  }
  const status: IngestJobStatus =
    extractedPages < totalPagesPdf
      ? "error"
      : estimate.requires_approval && !estimate.approved
        ? "paused_awaiting_ocr_approval"
        : "done";

  const latest = store.getLatestJob(paths.caseId);
  if (latest) {
    store.updateJob(latest.job_id, {
      status,
      updated_at: new Date().toISOString(),
      alerts,
      ocr_estimate: estimate,
    });
  }
  store.writeSnapshots(paths.caseId);
  writeCaseFile(paths, ledger, alerts, index);
  return status;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pageFileName(page: number): string {
  return `page-${String(page).padStart(6, "0")}.txt`;
}

function pageToUnit(caseId: string, page: number, text: string): EvidenceUnit {
  return {
    evidence_id: evidenceId(caseId, page, "p001"),
    case_id: caseId,
    page,
    unit_id: "p001",
    unit_type: "page_text",
    start_offset: 0,
    end_offset: text.length,
    hash: sha256(text),
    // Relativo ao diretório do caso: portátil e sem vazar layout da máquina.
    source_path: `pages/${pageFileName(page)}`,
    text,
  };
}

function writeCaseFile(
  paths: CaseRunnerPaths,
  ledger: PageLedgerEntry[],
  alerts: string[],
  index: CaseIndex,
): void {
  const statusPath = join(paths.caseDir, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as { needs_ocr_pages: number[] };
  const units = index.listUnits();
  const facts = extractCaseHeaderFacts(units);
  const events = reconcileCivilEvents(
    paths.caseId,
    extractCivilEvents({ caseId: paths.caseId, units }),
  );
  writeFileSync(
    join(paths.artifactsDir, "eventos_civeis.json"),
    JSON.stringify(events, null, 2),
  );
  // Mapa do caderno: o índice dos autos reconstruído do rodapé do PJe —
  // documentos com intervalo de páginas, data de juntada e tipo de peça.
  const documentMap = buildDocumentMap(units, ledger);
  writeFileSync(
    join(paths.artifactsDir, "mapa_caderno.json"),
    JSON.stringify(documentMap, null, 2),
  );
  writeFileSync(
    join(paths.artifactsDir, "case_file.json"),
    JSON.stringify(
      {
        case_id: paths.caseId,
        area: "civil",
        resumo: buildStructuralSummary({
          totalPages: ledger.length,
          facts,
          ledger,
          events,
        }),
        partes: facts.partes,
        valor_causa: facts.valor_causa,
        caderno: {
          total_documentos: documentMap.total_documentos,
          paginas_sem_documento: documentMap.paginas_sem_documento.length,
          aviso:
            documentMap.total_documentos > 0
              ? "Use a tool mapa_do_caderno para o indice completo dos autos (documentos, tipos, datas de juntada)."
              : "Nenhum rodape de documento (PJe) detectado neste caderno.",
        },
        needs_ocr_pages: status.needs_ocr_pages,
        alerts,
        evidence_count: ledger.length,
      },
      null,
      2,
    ),
  );
}

function caseRunnerPaths(root: string, caseId: string): CaseRunnerPaths {
  const normalizedCaseId = stableCaseId(caseId);
  const caseDir = resolveInsideRoot(root, join(root, normalizedCaseId));
  return {
    caseId: normalizedCaseId,
    caseDir,
    pagesDir: resolveInsideRoot(root, join(caseDir, "pages")),
    artifactsDir: resolveInsideRoot(root, join(caseDir, "artifacts")),
    db: resolveInsideRoot(root, join(caseDir, "index", "case.sqlite")),
    manifest: resolveInsideRoot(root, join(caseDir, "case.json")),
  };
}

function releaseLock(caseDir: string, lockOwner: string): void {
  const lockPath = join(caseDir, "case.lock");
  if (!existsSync(lockPath)) return;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { lock_owner?: string };
    if (lock.lock_owner === lockOwner) {
      unlinkSync(lockPath);
    }
  } catch {
    // Lock corrompido: deixa para o próximo acquire tratar como stale.
  }
}
