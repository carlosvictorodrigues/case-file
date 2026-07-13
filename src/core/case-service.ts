import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { detectLegalConcepts } from "../civil/case-file-facts.js";
import {
  citeDocument,
  findDocumentForPage,
  findFolhaEstj,
  findPaginaInternaEproc,
  type CaseDocument,
  type DocumentMap,
} from "../civil/document-map.js";
import { extractCivilEvents } from "../civil/event-extractor.js";
import { reconcileCivilEvents } from "../civil/event-reconciler.js";
import { buildCivilProceduralRadar } from "../civil/radar.js";
import { foldText } from "../civil/text-fold.js";
import { displayRef, evidenceId, stableCaseId } from "../domain/evidence.js";
import type {
  CaseManifest,
  CivilEvent,
  CivilProceduralRadar,
  CoverageManifest,
  CaseStatus,
  EvidenceUnit,
  PageLedgerEntry,
} from "../domain/types.js";
import {
  GoogleGeminiEmbeddingClient,
  type EmbeddingClient,
} from "../embeddings/gemini-embedding-client.js";
import { CaseJobStore } from "../jobs/job-store.js";
import {
  OCR_QUEUE_STATES,
  resumeIngestJob as resumeRunnerIngestJob,
  type OcrRuntimeOptions,
} from "../jobs/worker-runner.js";
import { ensureSinglePagePdfInput } from "../ocr/pdf-page-input.js";
import { stripPjeStamps } from "../ocr/text-quality.js";
import { ensurePagePdf } from "./open-local.js";
import { stripPersonalData } from "../security/pii.js";
import { redactSecrets } from "../security/redact.js";
import { CaseIndex, type SearchHit } from "../storage/index-db.js";
import { resolveInsideRoot } from "../storage/workspace.js";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function casePaths(root: string, caseId: string) {
  const normalizedCaseId = stableCaseId(caseId);
  const caseDir = resolveInsideRoot(root, join(root, normalizedCaseId));
  if (!existsSync(caseDir)) {
    throw new Error(`ENOENT: case not found, open '${caseDir}'`);
  }
  const artifactsDir = resolveInsideRoot(root, join(caseDir, "artifacts"));
  const pagesDir = resolveInsideRoot(root, join(caseDir, "pages"));
  const db = resolveInsideRoot(root, join(caseDir, "index", "case.sqlite"));

  return {
    caseId: normalizedCaseId,
    status: resolveInsideRoot(root, join(caseDir, "status.json")),
    artifactsDir,
    pagesDir,
    db,
  };
}

function readOptionalJson<T>(path: string): T | undefined {
  return existsSync(path) ? readJson<T>(path) : undefined;
}

/**
 * Faixa de custo do OCR por página escaneada em R$ (gemini-3.5-flash, tier
 * PAGO; a saída da transcrição domina o custo). Referência jul/2026 — o
 * preço é do Google e muda; a string diz isso. Faixa válida COM o raciocínio
 * interno desligado no cliente OCR (com thinking a fatura real de campo deu
 * ~R$0,198/pág — 4–10× a faixa).
 */
const OCR_CUSTO_MIN_BRL = 0.02;
const OCR_CUSTO_MAX_BRL = 0.05;

function brl(valor: number): string {
  return `R$ ${valor.toFixed(2).replace(".", ",")}`;
}

export function estimativaCustoOcr(paginas: number): string {
  return `${paginas} página(s) escaneada(s) ≈ ${brl(paginas * OCR_CUSTO_MIN_BRL)} a ${brl(
    paginas * OCR_CUSTO_MAX_BRL,
  )} na chave Gemini do usuário (gemini-3.5-flash, tier pago; referência jul/2026 — confirme a tabela vigente).`;
}

/** Preço gemini-3.5-flash tier pago (US$/1M tokens) e câmbio — referência jul/2026. */
const OCR_USD_POR_1M_ENTRADA = 1.5;
const OCR_USD_POR_1M_SAIDA = 9;
const USD_BRL = 5.4;

function custoAcumuladoOcr(tokens: { entrada: number; saida: number }): string {
  const usd =
    (tokens.entrada * OCR_USD_POR_1M_ENTRADA + tokens.saida * OCR_USD_POR_1M_SAIDA) / 1_000_000;
  return `≈ ${brl(usd * USD_BRL)} já gastos em OCR nesta ingestão (${tokens.entrada.toLocaleString(
    "pt-BR",
  )} tokens de entrada + ${tokens.saida.toLocaleString(
    "pt-BR",
  )} de saída, tabela de jul/2026 — o valor exato é o da fatura Google).`;
}

/** Acima disso a lista de páginas pendentes vira resumo (payload do chat). */
const NEEDS_OCR_LISTA_MAX = 20;
const NEEDS_OCR_LISTA_MOSTRA = 10;

export function getStatus(
  root: string,
  caseId: string,
): CaseStatus & {
  proxima_acao?: string;
  custo_estimado_ocr?: string;
  custo_acumulado_ocr?: string;
  needs_ocr_resumo?: string;
} {
  const paths = casePaths(root, caseId);
  const status = readJson<CaseStatus>(paths.status);
  // Orientação explícita (P13): status_caso é READ-ONLY e nunca dispara
  // custo — mas diz qual é a próxima chamada quando há pendência, e QUANTO
  // custa em reais (linguagem de orçamento, não "max_calls").
  let proximaAcao: string | undefined;
  let custoEstimado: string | undefined;
  const pendentes = status.needs_ocr_pages?.length ?? 0;
  if (status.status === "paused_awaiting_ocr_approval") {
    proximaAcao =
      "autorizar_ocr (apresente o custo_estimado_ocr ao usuário antes) e depois retomar_ingestao";
    custoEstimado = estimativaCustoOcr(pendentes);
  } else if (status.status === "error") {
    proximaAcao = "retomar_ingestao (retoma do ponto onde parou, sem repetir custo)";
  } else if (pendentes) {
    proximaAcao = "retomar_ingestao para processar as páginas de OCR pendentes";
    custoEstimado = estimativaCustoOcr(pendentes);
  }
  // Lista longa de páginas pendentes vira resumo: 800 números no status
  // estouram o chat sem informar nada além de "tem muita página".
  let needsOcrPages = status.needs_ocr_pages ?? [];
  let needsOcrResumo: string | undefined;
  if (needsOcrPages.length > NEEDS_OCR_LISTA_MAX) {
    needsOcrResumo = `${needsOcrPages.length} páginas pendentes de OCR (págs. ${needsOcrPages[0]}–${
      needsOcrPages[needsOcrPages.length - 1]
    } do PDF); mostrando as ${NEEDS_OCR_LISTA_MOSTRA} primeiras.`;
    needsOcrPages = needsOcrPages.slice(0, NEEDS_OCR_LISTA_MOSTRA);
  }
  return {
    ...status,
    needs_ocr_pages: needsOcrPages,
    needs_ocr_resumo: needsOcrResumo,
    proxima_acao: proximaAcao,
    custo_estimado_ocr: custoEstimado,
    custo_acumulado_ocr: status.ocr_tokens ? custoAcumuladoOcr(status.ocr_tokens) : undefined,
  };
}

export interface CaseListing {
  case_id: string;
  status?: string;
  total_pages?: number;
  partes?: string[];
  valor_causa?: string;
  documentos_no_caderno?: number;
  achados_no_dossie?: number;
  alertas?: number;
  atualizado_em?: string;
}

/**
 * Descoberta multi-caso: sem esta tool o modelo tem que ADIVINHAR o case_id.
 * Leve por construção — lê só os artefatos pequenos (status/case_file/dossiê),
 * nunca abre o SQLite de cada caso.
 */
export function listCases(root: string): { total: number; casos: CaseListing[]; aviso?: string } {
  if (!existsSync(root)) {
    return { total: 0, casos: [] };
  }
  const casos: CaseListing[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const caseDir = join(root, entry.name);
    if (!existsSync(join(caseDir, "case.json"))) continue;

    const listing: CaseListing = { case_id: entry.name };
    try {
      const status = readOptionalJson<CaseStatus>(join(caseDir, "status.json"));
      if (status) {
        listing.status = status.status;
        listing.total_pages = status.total_pages;
        listing.alertas = status.alerts?.length || undefined;
        listing.atualizado_em = statSync(join(caseDir, "status.json")).mtime.toISOString();
      }
      const caseFile = readOptionalJson<{
        partes?: Array<{ papel?: string; nome?: string }>;
        valor_causa?: { valor?: string };
        caderno?: { total_documentos?: number };
      }>(join(caseDir, "artifacts", "case_file.json"));
      if (caseFile) {
        listing.partes = caseFile.partes
          ?.filter((parte) => parte.nome)
          .map((parte) => `${String(parte.nome).slice(0, 60)}${parte.papel ? ` (${parte.papel})` : ""}`);
        listing.valor_causa = caseFile.valor_causa?.valor;
        listing.documentos_no_caderno = caseFile.caderno?.total_documentos || undefined;
      }
      const dossie = readOptionalJson<unknown[]>(join(caseDir, "artifacts", "dossie.json"));
      if (Array.isArray(dossie) && dossie.length) {
        listing.achados_no_dossie = dossie.length;
      }
    } catch {
      // Caso com artefato corrompido continua listado só com o case_id.
    }
    casos.push(listing);
  }
  casos.sort((a, b) => (b.atualizado_em ?? "").localeCompare(a.atualizado_em ?? ""));
  return {
    total: casos.length,
    casos,
    aviso: casos.length
      ? undefined
      : "Nenhum caso na pasta autorizada; use criar_caso_local com um PDF dentro dela.",
  };
}

/**
 * PAINEL do processo (<3KB por decisão do brainstorm P13): primeira
 * fotografia leve — partes, valor, cobertura em CONTAGENS e resumo do
 * caderno. Cronologia mora SÓ em linha_do_tempo; alertas SÓ no radar.
 * (Antes: 26KB com eventos+radar embutidos — sobreposição e gasto.)
 */
export function getCaseFile(root: string, caseId: string): unknown {
  const paths = casePaths(root, caseId);
  const base = readJson<Record<string, unknown>>(join(paths.artifactsDir, "case_file.json"));
  const painel: Record<string, unknown> = {
    case_id: base.case_id,
    area: base.area,
    resumo: base.resumo,
    partes: base.partes,
    valor_causa: base.valor_causa,
    alerts: base.alerts,
  };

  const coverage = readOptionalJson<CoverageManifest>(
    join(paths.artifactsDir, "coverage_manifest.json"),
  );
  if (coverage) {
    painel.cobertura = {
      total_paginas: coverage.total_pages,
      paginas_lidas: coverage.pages_read,
      ocr_pendente: coverage.pages_ocr_needed.length,
      falhas_retryable: coverage.pages_failed_retryable.length,
      paginas_sem_texto: coverage.pages_failed_permanent.length,
      paginas_so_carimbo: coverage.pages_ocr_stamp_only.length,
      lacunas_criticas: coverage.critical_gaps.length,
      analise_global_liberada: coverage.global_analysis_allowed,
      avisos: coverage.warnings,
    };
  }

  const mapa = loadDocumentMap(root, paths.caseId);
  if (mapa) {
    const porTipo = new Map<string, number>();
    for (const doc of mapa.documentos) {
      porTipo.set(doc.piece_type, (porTipo.get(doc.piece_type) ?? 0) + 1);
    }
    painel.caderno_resumo = {
      sistema: mapa.sistema ?? "pje",
      total_documentos: mapa.total_documentos,
      paginas_sem_documento: mapa.paginas_sem_documento.length,
      tipos: [...porTipo.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([tipo, count]) => ({ tipo, count })),
      principais: mapa.documentos
        .filter((doc) => PECAS_PROCESSUAIS.has(doc.piece_type) || doc.pages >= 20)
        .slice(0, 5)
        .map((doc) => ({
          num: doc.num,
          tipo: doc.piece_type,
          paginas: `${doc.first_page}-${doc.last_page}`,
          data_juntada: doc.signed_date,
          citacao: citeDocument(doc),
        })),
    };
  }

  const dossieJson = readOptionalJson<unknown[]>(join(paths.artifactsDir, "dossie.json"));
  painel.dossie = { achados: Array.isArray(dossieJson) ? dossieJson.length : 0 };
  painel.aviso =
    "Painel compacto. Cronologia: linha_do_tempo. Indice dos autos: mapa_do_caderno. Alertas de prazo: analisar_radar_processual_civel. Achados da investigacao: dossie.";
  return painel;
}

/** Tipos de peça que contam como "principais" no painel e no mapa. */
const PECAS_PROCESSUAIS = new Set([
  "inicial",
  "contestacao",
  "replica",
  "decisao",
  "sentenca",
  "recurso",
]);

export interface TimelineEntry {
  data?: string;
  origem: "evento" | "juntada";
  tipo: string;
  resumo: string;
  fonte_data?: string;
  evidence_id?: string;
  documento?: { num: string; paginas: string; citacao?: string };
}

/**
 * Linha do tempo DETERMINÍSTICA, montada server-side: eventos datados do
 * caso + datas de juntada de cada documento do caderno (rodapé do PJe).
 * Substitui o loop caro de "abrir página por página para montar cronologia"
 * (achado de campo: era a maior fonte de gasto de contexto no chat).
 */
export function consultarLinhaDoTempo(
  root: string,
  caseId: string,
  filtro?: { de?: string; ate?: string },
): {
  case_id: string;
  total: number;
  sem_data: number;
  entradas: TimelineEntry[];
  aviso: string;
} {
  const paths = casePaths(root, caseId);
  const entradas: TimelineEntry[] = [];

  const eventos =
    readOptionalJson<CivilEvent[]>(join(paths.artifactsDir, "eventos_civeis.json")) ?? [];
  for (const evento of eventos) {
    if (evento.status === "superseded") continue;
    entradas.push({
      data: evento.data_documento ?? evento.data_juntada,
      origem: "evento",
      tipo: evento.subtipo ? `${evento.tipo}/${evento.subtipo}` : evento.tipo,
      resumo: denseExcerpt(evento.descricao, 140) ?? "",
      fonte_data: evento.fonte_data,
      evidence_id: evento.canonical_evidence_id,
    });
  }

  const mapa = loadDocumentMap(root, caseId);
  for (const doc of mapa?.documentos ?? []) {
    entradas.push({
      data: doc.signed_date,
      origem: "juntada",
      tipo: doc.piece_type,
      resumo: `Documento ${doc.evento ? citeDocument(doc) : `Num. ${doc.num}`} juntado (${doc.pages} pág., ${doc.first_page}-${doc.last_page}${doc.signer ? `, assinado por ${doc.signer}` : ""})`,
      documento: {
        num: doc.num,
        paginas:
          doc.first_page === doc.last_page
            ? `${doc.first_page}`
            : `${doc.first_page}-${doc.last_page}`,
        citacao: citeDocument(doc),
      },
    });
  }

  const dentroDoPeriodo = (data?: string): boolean => {
    if (!data) return !filtro?.de && !filtro?.ate;
    if (filtro?.de && data < filtro.de) return false;
    if (filtro?.ate && data > filtro.ate) return false;
    return true;
  };
  const filtradas = entradas.filter((entrada) => dentroDoPeriodo(entrada.data));
  const semData = filtradas.filter((entrada) => !entrada.data).length;
  filtradas.sort((a, b) => {
    if (!a.data) return 1;
    if (!b.data) return -1;
    return a.data.localeCompare(b.data);
  });

  return {
    case_id: paths.caseId,
    total: filtradas.length,
    sem_data: semData,
    entradas: filtradas,
    aviso:
      "Data de juntada = assinatura eletrônica do rodapé (PJe). Evento narrado dentro de uma peça é a VERSÃO daquela parte — confirme na fonte primária antes de afirmar. Verbatim: ler_original(evidence_id).",
  };
}

export async function searchCase(
  root: string,
  caseId: string,
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  const paths = casePaths(root, caseId);
  const index = await CaseIndex.open(paths.db, root);
  try {
    return index.search(query, limit).map((hit) => ({
      ...hit,
      // A busca devolve o TRECHO (snippet); o verbatim integral da página só
      // sai por abrir_trecho/abrir_pagina — é o contrato anti-contaminação.
      text: undefined,
      display_ref: displayRef(hit),
    }));
  } finally {
    index.close();
  }
}

/**
 * Link local para "conferir no original": caminho absoluto + URL file:// do
 * PDF de página única (gerado sob demanda). Nunca derruba a tool que o
 * inclui — sem o original disponível, a leitura do texto segue valendo.
 */
async function originalPageLink(
  root: string,
  caseId: string,
  page: number,
): Promise<{ arquivo: string; link: string } | undefined> {
  try {
    const caseDir = resolveInsideRoot(root, join(root, caseId));
    const manifest = readJson<CaseManifest>(join(caseDir, "case.json"));
    const arquivo = await ensurePagePdf(root, caseDir, manifest.source_pdf, page);
    return { arquivo, link: pathToFileURL(arquivo).href };
  } catch {
    return undefined;
  }
}

export async function openEvidence(
  root: string,
  caseId: string,
  evidenceId: string,
): Promise<
  EvidenceUnit & {
    original?: { arquivo: string; link: string };
    documento?: DocumentRef;
  }
> {
  const paths = casePaths(root, caseId);
  const index = await CaseIndex.open(paths.db, root);
  try {
    const unit = index.getEvidence(evidenceId);
    if (!unit) {
      throw new Error(`evidence_id not found: ${evidenceId}`);
    }
    const docMap = loadDocumentMap(root, paths.caseId);
    return {
      ...unit,
      display_ref: displayRef(unit),
      original: await originalPageLink(root, paths.caseId, unit.page),
      documento: pageRef(docMap, unit.page),
    };
  } finally {
    index.close();
  }
}

export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-2";
const EMBED_BATCH_SIZE = 32;
/** Orçamento de tempo por chamada de indexar_semantica (timeout típico do cliente MCP é ~60s). */
const EMBED_TIME_BUDGET_MS = 20_000;
// PDFs de página única são pesados no payload; lotes menores.
const EMBED_VISUAL_BATCH_SIZE = 4;
const EMBED_CONCURRENT_BATCHES = 4;
const EMBED_TEXT_MAX_CHARS = 6000;
const RRF_K = 60;
// Versão do ESPAÇO vetorial: muda quando o formato do conteúdo embedado muda
// (ex.: prefixos de task do gemini-embedding-2). Vetores de versões antigas
// simplesmente não casam com a chave nova e são re-embedados sozinhos.
const VECTOR_SPACE_VERSION = "retrieval-v1";

function vectorSpaceKey(model: string): string {
  return `${model}|${VECTOR_SPACE_VERSION}`;
}

// Prefixos de retrieval recomendados pela doc do gemini-embedding-2 (uso
// assimétrico): consulta e documento têm formatos distintos e consistentes.
function formatRetrievalQuery(query: string): string {
  return `task: search result | query: ${query.slice(0, EMBED_TEXT_MAX_CHARS)}`;
}

function formatRetrievalDocument(text: string): string {
  return `title: none | text: ${text.slice(0, EMBED_TEXT_MAX_CHARS)}`;
}

export interface SemanticOptions {
  geminiApiKey?: string;
  model?: string;
  client?: EmbeddingClient;
}

function l2Normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return vector;
  return vector.map((value) => value / norm);
}

function dot(a: Float32Array | number[], b: Float32Array | number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

export interface SemanticIndexResult {
  case_id: string;
  model: string;
  embedded: number;
  /** Quantos dos embeddings foram de PÁGINA (PDF visual, sem texto usável). */
  embedded_visual: number;
  remaining: number;
  calls_made: number;
  aviso?: string;
}

interface EmbedWorkItem {
  evidence_id: string;
  content: { text: string } | { pdfBytes: () => Promise<Uint8Array> };
}

/**
 * Gera embeddings (BYOK) para as evidências que ainda não têm vetor.
 * Texto usa o formato de documento de retrieval do gemini-embedding-2;
 * páginas na fila de OCR (escaneadas, sem texto usável) são embedadas
 * VISUALMENTE como PDF de página única — buscáveis antes mesmo do OCR.
 * Opt-in com teto explícito de chamadas — o gate de custo é o próprio
 * contrato da tool. Idempotente: re-rodar só embeda o que falta.
 */
export async function indexSemantics(
  root: string,
  caseId: string,
  options: SemanticOptions & { maxCalls: number; batchSize?: number; timeBudgetMs?: number },
): Promise<SemanticIndexResult> {
  if (!options.geminiApiKey) {
    throw new Error("GEMINI_API_KEY e necessaria para indexar semanticamente.");
  }
  const paths = casePaths(root, caseId);
  const model = options.model ?? DEFAULT_EMBEDDING_MODEL;
  const spaceKey = vectorSpaceKey(model);
  const client = options.client ?? new GoogleGeminiEmbeddingClient();
  const batchSize = Math.max(1, options.batchSize ?? EMBED_BATCH_SIZE);
  const index = await CaseIndex.open(paths.db, root);
  try {
    const ledger =
      readOptionalJson<PageLedgerEntry[]>(
        join(paths.artifactsDir, "page_ledger.snapshot.json"),
      ) ?? [];
    // Fila de OCR, páginas permanentemente sem texto e OCR que só rendeu
    // carimbos (foto não transcrita): todas só são alcançáveis pela
    // representação VISUAL.
    const visualPages = ledger.filter(
      (entry) =>
        OCR_QUEUE_STATES.has(entry.state) ||
        entry.state === "failed_permanent" ||
        (entry.state === "ocr_done" && entry.ocr_yield === "stamp_only"),
    );
    const visualPageNumbers = new Set(visualPages.map((entry) => entry.page));
    const existingVectors = new Set(index.listVectors(spaceKey).map((v) => v.evidence_id));

    const textualItems: EmbedWorkItem[] = index
      .missingVectorEvidence(spaceKey)
      .filter((item) => !visualPageNumbers.has(item.page))
      .map((item) => ({
        evidence_id: item.evidence_id,
        content: { text: formatRetrievalDocument(item.text) },
      }));

    const manifest = readJson<CaseManifest>(
      resolveInsideRoot(root, join(root, paths.caseId, "case.json")),
    );
    const visualItems: EmbedWorkItem[] = visualPages
      .map((entry) => ({
        page: entry.page,
        evidence_id: entry.evidence_ids[0] ?? evidenceId(paths.caseId, entry.page, "p001"),
      }))
      .filter((entry) => !existingVectors.has(entry.evidence_id))
      .map((entry) => ({
        evidence_id: entry.evidence_id,
        content: {
          pdfBytes: async () => {
            const input = await ensureSinglePagePdfInput({
              sourcePdfPath: manifest.source_pdf,
              pagesDir: paths.pagesDir,
              page: entry.page,
            });
            return input.bytes;
          },
        },
      }));

    const total = textualItems.length + visualItems.length;
    let embedded = 0;
    let embeddedVisual = 0;
    let calls = 0;
    let aviso: string | undefined;

    // Orçamento de TEMPO por chamada: itens visuais (extração de página +
    // upload de PDF) estouravam o timeout do cliente MCP num caso grande
    // (achado de campo caso-2). A chamada para de despachar lotes novos ao
    // esgotar o orçamento e devolve `remaining` — re-rodar continua de onde
    // parou (idempotente). Pelo menos UM lote sempre roda (progresso).
    const startedAt = Date.now();
    const timeBudgetMs = options.timeBudgetMs ?? EMBED_TIME_BUDGET_MS;
    let batchesDispatched = 0;
    let budgetExhausted = false;

    // Lotes despachados em paralelo (pool pequeno): o custo por chamada é o
    // mesmo, o tempo de parede cai ~4x em casos grandes.
    const runBatches = async (items: EmbedWorkItem[], size: number, visual: boolean) => {
      const totalBatches = Math.ceil(items.length / size);
      let nextBatch = 0;
      const batchWorker = async (): Promise<void> => {
        while (!aviso) {
          if (calls >= options.maxCalls) return;
          if (batchesDispatched > 0 && Date.now() - startedAt > timeBudgetMs) {
            budgetExhausted = true;
            return;
          }
          const batchIndex = nextBatch++;
          if (batchIndex >= totalBatches) return;
          batchesDispatched++;
          const batch = items.slice(batchIndex * size, batchIndex * size + size);
          calls++;
          try {
            const prepared = await Promise.all(
              batch.map(async (item) =>
                "text" in item.content
                  ? { text: item.content.text }
                  : { pdfBytes: await item.content.pdfBytes() },
              ),
            );
            const vectors = await client.embedContents({
              items: prepared,
              apiKey: options.geminiApiKey as string,
              model,
            });
            index.upsertVectors(
              batch.map((item, i) => ({
                evidence_id: item.evidence_id,
                model: spaceKey,
                vector: l2Normalize(vectors[i] ?? []),
              })),
            );
            embedded += batch.length;
            if (visual) embeddedVisual += batch.length;
          } catch (error) {
            aviso = redactSecrets(
              error instanceof Error ? error.message : "Falha ao gerar embeddings.",
              [options.geminiApiKey],
            );
          }
        }
      };
      const poolSize = Math.max(1, Math.min(EMBED_CONCURRENT_BATCHES, totalBatches));
      await Promise.all(Array.from({ length: poolSize }, () => batchWorker()));
    };

    await runBatches(textualItems, batchSize, false);
    await runBatches(visualItems, Math.min(batchSize, EMBED_VISUAL_BATCH_SIZE), true);

    if (!aviso && budgetExhausted && embedded < total) {
      aviso =
        "Tempo desta chamada esgotado (protecao contra timeout do cliente); rode indexar_semantica novamente para continuar — idempotente, so embeda o que falta.";
    }

    return {
      case_id: paths.caseId,
      model,
      embedded,
      embedded_visual: embeddedVisual,
      remaining: total - embedded,
      calls_made: calls,
      aviso,
    };
  } finally {
    index.close();
  }
}

export interface DocumentRef {
  num?: string;
  tipo?: string;
  paginas?: string;
  data_juntada?: string;
  /** Página DENTRO do documento (a que se cita no processo eletrônico). */
  pag_no_documento?: number;
  /** e-STJ: folha carimbada na página (a unidade citável no STJ). */
  folha_estj?: number;
  /**
   * Citação forense pronta no padrão do sistema de origem — copie
   * literalmente: PJe "ID <num>, pág. <interna>" · eproc "Evento <N>,
   * <DOC>, p. <interna>" · STJ "e-STJ, fl. <folha>".
   */
  citacao?: string;
}

function loadDocumentMap(root: string, caseId: string): DocumentMap | undefined {
  const paths = casePaths(root, caseId);
  return readOptionalJson<DocumentMap>(join(paths.artifactsDir, "mapa_caderno.json"));
}

function documentRef(doc: CaseDocument | undefined, page?: number): DocumentRef | undefined {
  if (!doc) return undefined;
  const ref: DocumentRef = {
    num: doc.num,
    tipo: doc.piece_type,
    paginas: doc.first_page === doc.last_page ? `${doc.first_page}` : `${doc.first_page}-${doc.last_page}`,
    data_juntada: doc.signed_date,
  };
  if (page !== undefined) {
    // Página interna assume intervalo contíguo do documento (validado no
    // caso real: global 864 = ID 150956859 pág. 299 = 566+298). Se o
    // intervalo tiver buraco (página sem rodapé no meio), pode desviar —
    // a instruction manda conferir no original antes de protocolar.
    const pagNoDocumento = page - doc.first_page + 1;
    ref.pag_no_documento = pagNoDocumento;
    ref.citacao = doc.evento
      ? `${citeDocument(doc)}, p. ${pagNoDocumento}`
      : `ID ${doc.num}, pág. ${pagNoDocumento}`;
  }
  return ref;
}

/** Referência citável da página no padrão do sistema (documento ou folha e-STJ). */
function pageRef(map: DocumentMap | undefined, page: number): DocumentRef | undefined {
  const doc = findDocumentForPage(map, page);
  const ref = documentRef(doc, page);
  if (ref) {
    // eproc: a página interna CARIMBADA no cabeçalho vence a contiguidade
    // (a capa separadora do evento não corrompe a numeração).
    const carimbada = doc?.evento ? findPaginaInternaEproc(map, page) : undefined;
    if (carimbada !== undefined && doc) {
      ref.pag_no_documento = carimbada;
      ref.citacao = `${citeDocument(doc)}, p. ${carimbada}`;
    }
    return ref;
  }
  const folha = findFolhaEstj(map, page);
  if (folha === undefined) return undefined;
  return { folha_estj: folha, citacao: `e-STJ, fl. ${folha}` };
}

export interface MapaCadernoOptions {
  tipo?: string;
  modo?: "principais" | "completo";
  limit?: number;
  offset?: number;
  min_paginas?: number;
}

/**
 * Índice dos autos com defesa anti-bomba-de-contexto (decisão P13): o modo
 * default "principais" detalha peças processuais e documentos longos e
 * AGRUPA o restante por tipo (contagem + intervalo); "completo" é paginado.
 * (Antes: 83 documentos de uma vez = milhares de tokens por chamada.)
 */
export function consultarMapaCaderno(
  root: string,
  caseId: string,
  options: MapaCadernoOptions | string = {},
): {
  sistema: string;
  total_documentos: number;
  modo: "principais" | "completo";
  retornados: number;
  has_more: boolean;
  paginas_sem_documento: number;
  documentos: Array<CaseDocument & { citacao: string }>;
  grupos?: Array<{
    tipo: string;
    count: number;
    total_paginas: number;
    intervalo: string;
    exemplos: Array<{ num: string; paginas: string; citacao: string }>;
  }>;
  aviso?: string;
} {
  // Compat: a assinatura antiga aceitava o filtro de tipo como string.
  const opts: MapaCadernoOptions = typeof options === "string" ? { tipo: options } : options;
  const map = loadDocumentMap(root, caseId);
  if (!map) {
    return {
      sistema: "desconhecido",
      total_documentos: 0,
      modo: opts.modo ?? "principais",
      retornados: 0,
      has_more: false,
      paginas_sem_documento: 0,
      documentos: [],
    };
  }

  const comCitacao = (doc: CaseDocument): CaseDocument & { citacao: string } => ({
    ...doc,
    citacao: citeDocument(doc),
  });

  const sistema = map.sistema ?? "pje";
  // e-STJ carimba FOLHA por página, não fronteira de documento: não há
  // índice por peça, mas toda citação sai como (e-STJ, fl. N) nas buscas.
  const avisoSistema =
    sistema === "estj"
      ? `Caderno do e-STJ: ${map.paginas_mapeadas} página(s) com folha carimbada — cite por (e-STJ, fl. N), presente em cada trecho da busca. Índice por documento indisponível neste formato.`
      : sistema === "desconhecido"
        ? "Nenhum carimbo de sistema reconhecido (PJe/eproc/e-STJ): índice indisponível; cite por página do PDF, sempre rotulada."
        : undefined;

  const filtrados = opts.tipo
    ? map.documentos.filter((doc) => doc.piece_type === opts.tipo)
    : map.documentos;

  const modo = opts.modo ?? (opts.tipo ? "completo" : "principais");
  if (modo === "completo") {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    const offset = Math.max(0, opts.offset ?? 0);
    const page = filtrados.slice(offset, offset + limit);
    return {
      sistema,
      total_documentos: filtrados.length,
      modo,
      retornados: page.length,
      has_more: offset + page.length < filtrados.length,
      paginas_sem_documento: map.paginas_sem_documento.length,
      documentos: page.map(comCitacao),
      aviso: avisoSistema,
    };
  }

  const minPaginas = Math.max(1, opts.min_paginas ?? 3);
  const principais: CaseDocument[] = [];
  const restantes: CaseDocument[] = [];
  for (const doc of filtrados) {
    if (PECAS_PROCESSUAIS.has(doc.piece_type) || doc.pages >= minPaginas) {
      principais.push(doc);
    } else {
      restantes.push(doc);
    }
  }

  const porTipo = new Map<string, CaseDocument[]>();
  for (const doc of restantes) {
    const grupo = porTipo.get(doc.piece_type) ?? [];
    grupo.push(doc);
    porTipo.set(doc.piece_type, grupo);
  }
  const grupos = [...porTipo.entries()].map(([tipo, docs]) => ({
    tipo,
    count: docs.length,
    total_paginas: docs.reduce((sum, doc) => sum + doc.pages, 0),
    intervalo: `${Math.min(...docs.map((d) => d.first_page))}-${Math.max(...docs.map((d) => d.last_page))}`,
    exemplos: docs.slice(0, 2).map((doc) => ({
      num: doc.num,
      paginas:
        doc.first_page === doc.last_page
          ? `${doc.first_page}`
          : `${doc.first_page}-${doc.last_page}`,
      citacao: citeDocument(doc),
    })),
  }));

  const avisoPrincipais = restantes.length
    ? `Exibindo pecas principais; ${restantes.length} documento(s) menores agrupados por tipo. Para a lista integral use modo="completo" (paginado) ou filtre por tipo.`
    : undefined;
  return {
    sistema,
    total_documentos: filtrados.length,
    modo,
    retornados: principais.length,
    has_more: restantes.length > 0,
    paginas_sem_documento: map.paginas_sem_documento.length,
    documentos: principais.map(comCitacao),
    grupos: grupos.length ? grupos : undefined,
    aviso: [avisoSistema, avisoPrincipais].filter(Boolean).join(" ") || undefined,
  };
}

/**
 * Hit da busca no formato de CONVERSA (dieta de contexto): fica o que o
 * modelo usa para triagem e citação — evidence_id, página, trecho, origem
 * documental e proveniência de OCR. Hash/offsets/paths ficam no índice;
 * o verbatim integral sai por abrir_trecho.
 */
export interface ChatSearchHit {
  evidence_id: string;
  page: number;
  display_ref?: string;
  unit_type: EvidenceUnit["unit_type"];
  snippet?: string;
  ocr?: EvidenceUnit["ocr"];
  documento?: DocumentRef;
}

export interface HybridSearchResult {
  results: ChatSearchHit[];
  busca: { modo: "hibrida" | "lexical"; aviso?: string };
}

/**
 * Busca híbrida: FTS (bm25) + cosseno sobre os vetores locais, fundidos por
 * RRF. Sem chave ou sem índice semântico, degrada para lexical com aviso.
 */
export async function searchCaseHybrid(
  root: string,
  caseId: string,
  query: string,
  limit: number,
  options: SemanticOptions = {},
): Promise<HybridSearchResult> {
  const paths = casePaths(root, caseId);
  const model = options.model ?? DEFAULT_EMBEDDING_MODEL;
  const docMap = loadDocumentMap(root, caseId);
  const index = await CaseIndex.open(paths.db, root);
  try {
    const lexical = index.search(query, limit);
    // Cada hit sai anotado com o DOCUMENTO de origem (peça/contrato/certidão):
    // é o que permite distinguir fonte primária de menção e atribuir a
    // alegação à parte correta.
    // Sem `score` na conversa (decisão P13): o modelo não converte bm25/RRF
    // em decisão melhor — re-rankeia pelo texto; a ORDEM dos hits já carrega
    // o ranking.
    const strip = (hit: EvidenceUnit & { snippet?: string }): ChatSearchHit => ({
      evidence_id: hit.evidence_id,
      page: hit.page,
      display_ref: displayRef(hit),
      unit_type: hit.unit_type,
      snippet: hit.snippet,
      ocr: hit.ocr,
      documento: pageRef(docMap, hit.page),
    });

    const vectors = options.geminiApiKey ? index.listVectors(vectorSpaceKey(model)) : [];
    if (!options.geminiApiKey || vectors.length === 0) {
      const aviso =
        options.geminiApiKey && vectors.length === 0
          ? "Caso sem indice semantico; use indexar_semantica para busca por significado."
          : undefined;
      return { results: lexical.map(strip), busca: { modo: "lexical", aviso } };
    }

    const client = options.client ?? new GoogleGeminiEmbeddingClient();
    let queryVector: number[];
    try {
      const [raw] = await client.embedContents({
        items: [{ text: formatRetrievalQuery(query) }],
        apiKey: options.geminiApiKey,
        model,
      });
      queryVector = l2Normalize(raw ?? []);
    } catch (error) {
      return {
        results: lexical.map(strip),
        busca: {
          modo: "lexical",
          aviso: redactSecrets(
            error instanceof Error ? error.message : "Falha ao embedar a consulta.",
            [options.geminiApiKey],
          ),
        },
      };
    }

    const semanticRanking = vectors
      .map((entry) => ({ evidence_id: entry.evidence_id, score: dot(queryVector, entry.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Reciprocal Rank Fusion entre a lista lexical e a semântica.
    const fused = new Map<string, number>();
    lexical.forEach((hit, rank) => {
      fused.set(hit.evidence_id, (fused.get(hit.evidence_id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
    semanticRanking.forEach((entry, rank) => {
      fused.set(entry.evidence_id, (fused.get(entry.evidence_id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
    const lexicalById = new Map(lexical.map((hit) => [hit.evidence_id, hit]));
    const results: ChatSearchHit[] = [];
    for (const [evidenceId] of [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
      const fromLexical = lexicalById.get(evidenceId);
      if (fromLexical) {
        results.push(strip(fromLexical));
        continue;
      }
      const unit = index.getEvidence(evidenceId);
      if (!unit) continue;
      results.push({
        ...strip(unit),
        snippet: denseExcerpt(unit.text),
      });
    }
    return { results, busca: { modo: "hibrida" } };
  } finally {
    index.close();
  }
}

/**
 * Excerto de hit SEMÂNTICO (sem match lexical para o snippet do FTS): o head
 * da página costuma ser o RODAPÉ do PJe (a extração traz o carimbo primeiro),
 * então o excerto útil é o começo do CONTEÚDO após remover os carimbos.
 */
function denseExcerpt(text: string | undefined, max = 240): string | undefined {
  if (!text) return undefined;
  const cleaned = stripPjeStamps(text).replace(/\s+/g, " ").trim();
  const base = cleaned.length >= 40 ? cleaned : text.replace(/\s+/g, " ").trim();
  if (!base) return undefined;
  return base.length > max ? `${base.slice(0, max)} …` : base;
}

export interface OcorrenciaControversia {
  evidence_id: string;
  citacao?: string;
  documento?: DocumentRef;
  trecho?: string;
  tipo_fonte:
    | "alegacao_autor"
    | "alegacao_reu"
    | "replica_autor"
    | "ato_judicial"
    | "prova_primaria";
}

export interface TemaControversia {
  tema: string;
  inicial: OcorrenciaControversia[];
  contestacao: OcorrenciaControversia[];
  replica: OcorrenciaControversia[];
  atos_judiciais: OcorrenciaControversia[];
  fontes_primarias: OcorrenciaControversia[];
  lacunas: string[];
}

/**
 * Quadro de controvérsias (gap #1 do brainstorm P13): o job real do
 * contencioso — cruzar o que o AUTOR alegou com o que o RÉU respondeu,
 * tema a tema, e achar os fatos sem impugnação específica.
 *
 * Divisão de trabalho decidida no brainstorm: o SERVIDOR faz o retrieval
 * determinístico (busca híbrida por tema, ocorrências agrupadas pela peça
 * de origem via intervalos do mapa do caderno); o PAREAMENTO jurídico —
 * "isso rebate aquilo?" — é julgamento do MODELO. O servidor nunca decide;
 * grupo vazio vira lacuna explícita.
 */
export async function mapearControversias(
  root: string,
  caseId: string,
  temas: Array<{ nome: string; queries?: string[] }>,
  options: SemanticOptions & {
    limitPorTema?: number;
    incluirFontesPrimarias?: boolean;
  } = {},
): Promise<{
  case_id: string;
  pecas_identificadas: Record<string, Array<{ num: string; paginas: string; citacao: string }>>;
  temas: TemaControversia[];
  aviso_pareamento: string;
  aviso?: string;
}> {
  const paths = casePaths(root, caseId);
  const mapa = loadDocumentMap(root, paths.caseId);
  const limitPorTema = Math.min(Math.max(1, options.limitPorTema ?? 4), 10);
  const incluirPrimarias = options.incluirFontesPrimarias ?? true;

  // Peças por papel, a partir do tipo classificado no mapa do caderno.
  const papelPorTipo: Record<string, keyof Omit<TemaControversia, "tema" | "lacunas">> = {
    inicial: "inicial",
    contestacao: "contestacao",
    replica: "replica",
    decisao: "atos_judiciais",
    sentenca: "atos_judiciais",
  };
  const tipoFontePorPapel: Record<string, OcorrenciaControversia["tipo_fonte"]> = {
    inicial: "alegacao_autor",
    contestacao: "alegacao_reu",
    replica: "replica_autor",
    atos_judiciais: "ato_judicial",
  };

  const pecasIdentificadas: Record<
    string,
    Array<{ num: string; paginas: string; citacao: string }>
  > = {};
  for (const doc of mapa?.documentos ?? []) {
    const papel = papelPorTipo[doc.piece_type];
    if (!papel) continue;
    (pecasIdentificadas[papel] ??= []).push({
      num: doc.num,
      paginas: `${doc.first_page}-${doc.last_page}`,
      citacao: citeDocument(doc),
    });
  }

  const papelDaPagina = (page: number): keyof typeof tipoFontePorPapel | "fora" => {
    const doc = findDocumentForPage(mapa, page);
    if (!doc) return "fora";
    return (papelPorTipo[doc.piece_type] as keyof typeof tipoFontePorPapel) ?? "fora";
  };

  const resultado: TemaControversia[] = [];
  for (const tema of temas) {
    const buckets: TemaControversia = {
      tema: tema.nome,
      inicial: [],
      contestacao: [],
      replica: [],
      atos_judiciais: [],
      fontes_primarias: [],
      lacunas: [],
    };
    const queries = tema.queries?.length ? tema.queries : [tema.nome];
    const vistos = new Set<string>();

    for (const query of queries) {
      // Busca ampla (o triplo do limite por peça) e depois bucketização.
      const { results } = await searchCaseHybrid(root, caseId, query, limitPorTema * 6, options);
      for (const hit of results) {
        if (vistos.has(hit.evidence_id)) continue;
        const papel = papelDaPagina(hit.page);
        const ocorrencia: OcorrenciaControversia = {
          evidence_id: hit.evidence_id,
          citacao: hit.documento?.citacao,
          documento: hit.documento,
          trecho: hit.snippet,
          tipo_fonte:
            papel === "fora" ? "prova_primaria" : tipoFontePorPapel[papel] ?? "prova_primaria",
        };
        if (papel === "fora") {
          if (incluirPrimarias && buckets.fontes_primarias.length < limitPorTema) {
            vistos.add(hit.evidence_id);
            buckets.fontes_primarias.push(ocorrencia);
          }
          continue;
        }
        const bucket = buckets[papel as "inicial" | "contestacao" | "replica" | "atos_judiciais"];
        if (bucket.length < limitPorTema) {
          vistos.add(hit.evidence_id);
          bucket.push(ocorrencia);
        }
      }
    }

    if (pecasIdentificadas.inicial && !buckets.inicial.length) {
      buckets.lacunas.push("Sem ocorrência do tema na petição inicial.");
    }
    if (pecasIdentificadas.contestacao && !buckets.contestacao.length) {
      buckets.lacunas.push(
        "Sem ocorrência do tema na contestação — candidato a fato sem impugnação específica (confirme lendo a peça).",
      );
    }
    if (!pecasIdentificadas.contestacao) {
      buckets.lacunas.push("Contestação não identificada no caderno.");
    }
    resultado.push(buckets);
  }

  return {
    case_id: paths.caseId,
    pecas_identificadas: pecasIdentificadas,
    temas: resultado,
    aviso_pareamento:
      "Candidatos agrupados por peça de origem; o pareamento alegação↔impugnação e a conclusão jurídica cabem a você. Grupo vazio = 'não localizei impugnação específica', nunca 'não existe'.",
    aviso:
      mapa && mapa.total_documentos > 0
        ? undefined
        : mapa?.sistema === "estj"
          ? "Caderno do e-STJ: sem fronteira de documento no carimbo — ocorrências sem atribuição de peça, mas cada uma sai citável por (e-STJ, fl. N)."
          : "Caderno sem mapa de documentos (carimbo PJe/eproc/e-STJ não detectado): ocorrências sem atribuição de peça.",
  };
}

export interface EvidenceBundle {
  case_id: string;
  objetivo: string;
  lado: string;
  coverage?: CoverageManifest;
  fatos_relevantes: Array<{
    texto: string;
    evidence_id: string;
    trecho: string;
    display_ref?: string;
  }>;
  provas: unknown[];
  teses_sugeridas: string[];
  radar_processual: unknown[];
  lacunas: unknown[];
  queries_jurisprudencia: Array<{
    query: string;
    fundamento_no_caso: string[];
  }>;
}

const FALLBACK_QUERIES = [
  "autor pagamento dano prescricao contestacao",
  "pagamento",
  "dano",
  "prescricao",
  "contestacao",
];

export async function buildEvidenceBundle(
  root: string,
  caseId: string,
  objetivo: string,
  lado: string,
  maxItems: number,
  options: SemanticOptions & { dadosPessoaisAdicionais?: string[] } = {},
): Promise<EvidenceBundle> {
  const paths = casePaths(root, caseId);

  // 1) Busca dirigida pelo OBJETIVO do advogado (híbrida quando o caso tem
  //    índice semântico); só cai para conceitos genéricos se o objetivo não
  //    encontrar nada.
  const primary = await searchCaseHybrid(
    root,
    caseId,
    `${objetivo} ${lado}`.trim(),
    maxItems,
    options,
  );
  let hits = primary.results;
  if (!hits.length) {
    for (const query of FALLBACK_QUERIES) {
      hits = await searchCase(root, caseId, query, maxItems);
      if (hits.length > 0) break;
    }
  }
  const fatos = hits.map((hit) => {
    const trecho = (hit.snippet ?? "").replaceAll("«", "").replaceAll("»", "");
    return {
      texto: trecho.slice(0, 240),
      evidence_id: hit.evidence_id,
      trecho: trecho.slice(0, 500),
      display_ref: hit.display_ref,
    };
  });

  const caseFile = readOptionalJson<{ partes?: Array<{ nome?: string }> }>(
    join(paths.artifactsDir, "case_file.json"),
  );
  // LGPD (hardening P13): além das partes extraídas, o chamador pode listar
  // nomes de TERCEIROS citados no objetivo (testemunha, sócio, preposto) —
  // o furo que a extração automática não cobre.
  const partyNames = [
    ...(caseFile?.partes ?? []).map((parte) => parte.nome ?? "").filter((nome) => nome.length > 0),
    ...(options.dadosPessoaisAdicionais ?? []),
  ];
  const coverage = readOptionalJson<CoverageManifest>(
    join(paths.artifactsDir, "coverage_manifest.json"),
  );
  const radar = readOptionalJson<CivilProceduralRadar>(
    join(paths.artifactsDir, "radar_processual_civel.json"),
  );
  const ledger =
    readOptionalJson<PageLedgerEntry[]>(join(paths.artifactsDir, "page_ledger.snapshot.json")) ??
    [];

  // Provas documentais candidatas: páginas classificadas como comprovante.
  const provas = ledger
    .filter((entry) => entry.piece_type === "comprovante")
    .map((entry) => ({
      tipo: "comprovante",
      page: entry.page,
      evidence_id: entry.evidence_ids[0],
      display_ref: `pagina ${entry.page}`,
    }));

  // Teses candidatas vêm do radar (hipóteses conferíveis, nunca conclusão).
  const teses = radar
    ? [
        ...new Set(
          [...radar.prazos_candidatos, ...radar.oportunidades].map((item) => item.hipotese),
        ),
      ]
    : [];

  // Query de jurisprudência SEM dados pessoais: objetivo + conceitos jurídicos
  // detectados nos fatos — nomes de partes, CPF/CNPJ, nº CNJ e e-mails nunca
  // saem do ambiente local (minimização LGPD).
  const concepts = detectLegalConcepts(fatos.map((fato) => fato.trecho));
  const objetivoFolded = foldText(objetivo);
  const queryTerms = [objetivo, ...concepts.filter((c) => !objetivoFolded.includes(c))];
  const queryText = stripPersonalData(queryTerms.join(" "), partyNames).slice(0, 300);

  return {
    case_id: paths.caseId,
    objetivo,
    lado,
    coverage,
    fatos_relevantes: fatos,
    provas,
    teses_sugeridas: teses,
    radar_processual: radar ? radar.prazos_candidatos.concat(radar.oportunidades) : [],
    lacunas: coverage?.critical_gaps ?? [],
    queries_jurisprudencia: fatos.length
      ? [
          {
            query: queryText,
            fundamento_no_caso: fatos.map((fato) => fato.evidence_id).slice(0, 10),
          },
        ]
      : [],
  };
}

export async function resumeIngestJob(
  root: string,
  caseId: string,
  geminiApiKey?: string,
  ocr?: OcrRuntimeOptions,
) {
  return resumeRunnerIngestJob({ root, caseId, geminiApiKey, ocr });
}

export async function authorizeOcr(
  root: string,
  caseId: string,
  limits: { max_pages: number; max_calls: number },
) {
  const paths = casePaths(root, caseId);
  const store = await CaseJobStore.open(paths.db, root, paths.artifactsDir);
  try {
    const estimate = store.authorizeOcr(paths.caseId, limits);
    store.writeSnapshots(paths.caseId);
    return {
      case_id: paths.caseId,
      ocr_authorized: estimate.approved,
      max_pages: estimate.max_pages,
      max_calls: estimate.max_calls,
      status: store.getLatestJob(paths.caseId)?.status ?? "running",
    };
  } finally {
    store.close();
  }
}

export async function analyzeCivilRadar(
  root: string,
  caseId: string,
  lado: "autor" | "reu",
): Promise<CivilProceduralRadar> {
  const paths = casePaths(root, caseId);
  const units = await evidenceUnitsFromLedger(root, paths.caseId);
  const rawEvents = extractCivilEvents({ caseId: paths.caseId, units });
  const events = reconcileCivilEvents(paths.caseId, rawEvents);
  const coverage =
    readOptionalJson<CoverageManifest>(join(paths.artifactsDir, "coverage_manifest.json")) ??
    defaultCoverage(paths.caseId);
  const radar = buildCivilProceduralRadar({
    case_id: paths.caseId,
    lado,
    events,
    coverage,
  });
  writeFileSync(
    join(paths.artifactsDir, "eventos_civeis_raw.jsonl"),
    rawEvents.map((event) => JSON.stringify(event)).join("\n"),
  );
  writeFileSync(join(paths.artifactsDir, "eventos_civeis.json"), JSON.stringify(events, null, 2));
  writeFileSync(
    join(paths.artifactsDir, "radar_processual_civel.json"),
    JSON.stringify(radar, null, 2),
  );
  return radar;
}

export async function analyzeCivilCase(
  root: string,
  caseId: string,
  objetivo: string,
  lado: "autor" | "reu",
  maxItems: number,
  options: SemanticOptions = {},
): Promise<unknown> {
  const paths = casePaths(root, caseId);
  const coverage =
    readOptionalJson<CoverageManifest>(join(paths.artifactsDir, "coverage_manifest.json")) ??
    defaultCoverage(paths.caseId);
  const radar = await analyzeCivilRadar(root, paths.caseId, lado);
  const bundle = await buildEvidenceBundle(root, paths.caseId, objetivo, lado, maxItems, options);
  return {
    ...bundle,
    coverage,
    radar_processual: radar.prazos_candidatos.concat(radar.oportunidades),
    global_analysis_allowed: coverage.global_analysis_allowed,
  };
}

async function evidenceUnitsFromLedger(root: string, caseId: string): Promise<EvidenceUnit[]> {
  const paths = casePaths(root, caseId);
  const ledger = readOptionalJson<Array<{ evidence_ids?: string[] }>>(
    join(paths.artifactsDir, "page_ledger.snapshot.json"),
  );
  if (!ledger) return [];
  const evidenceIds = [...new Set(ledger.flatMap((row) => row.evidence_ids ?? []))];
  const index = await CaseIndex.open(paths.db, root);
  try {
    return evidenceIds.flatMap((id) => {
      const unit = index.getEvidence(id);
      return unit ? [unit] : [];
    });
  } finally {
    index.close();
  }
}

function defaultCoverage(caseId: string): CoverageManifest {
  return {
    case_id: caseId,
    total_pages: 0,
    pages_read: 0,
    pages_pending: [],
    pages_ocr_needed: [],
    pages_ocr_done: [],
    pages_failed_retryable: [],
    pages_failed_permanent: [],
    pages_ocr_stamp_only: [],
    pages_unknown_unread: [],
    ocr_estimate: { pages: 0, calls: 0, requires_approval: false, approved: true },
    critical_gaps: [],
    global_analysis_allowed: true,
    warnings: [],
  };
}

export async function openPage(
  root: string,
  caseId: string,
  page: number,
): Promise<{
  case_id: string;
  page: number;
  text: string;
  display_ref: string;
  original?: { arquivo: string; link: string };
  documento?: DocumentRef;
}> {
  const paths = casePaths(root, caseId);
  const pagePath = resolveInsideRoot(
    root,
    join(paths.pagesDir, `page-${String(page).padStart(6, "0")}.txt`),
  );
  const text = readFileSync(pagePath, "utf8");
  const docMap = loadDocumentMap(root, paths.caseId);

  return {
    case_id: paths.caseId,
    page,
    text,
    display_ref: `pagina ${page}`,
    original: await originalPageLink(root, paths.caseId, page),
    documento: pageRef(docMap, page),
  };
}
