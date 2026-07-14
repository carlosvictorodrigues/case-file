import { isPotentiallyCritical } from "../civil/piece-classifier.js";
import type { CoverageManifest, OcrEstimate, PageLedgerEntry } from "../domain/types.js";

const READ_STATES = new Set([
  "native_extracted",
  "ocr_done",
  "done",
  "failed_permanent",
  "skipped_no_key",
]);
const OCR_NEEDED_STATES = new Set(["ocr_needed", "ocr_running", "skipped_no_key"]);

export function buildCoverageManifest(input: {
  case_id: string;
  total_pages: number;
  pages: PageLedgerEntry[];
  ocr_estimate: OcrEstimate;
}): CoverageManifest {
  const pagesPending = input.pages.filter((p) => p.state === "pending").map((p) => p.page);
  const pagesOcrNeeded = input.pages
    .filter((p) => OCR_NEEDED_STATES.has(p.state))
    .map((p) => p.page);
  const pagesOcrDone = input.pages.filter((p) => p.state === "ocr_done").map((p) => p.page);
  const pagesFailedRetryable = input.pages
    .filter((p) => p.state === "failed_retryable")
    .map((p) => p.page);
  const pagesFailedPermanent = input.pages
    .filter((p) => p.state === "failed_permanent")
    .map((p) => p.page);
  const pagesUnknownUnread = input.pages
    .filter(
      (p) =>
        p.piece_type === "unknown" &&
        p.native_text_chars === 0 &&
        ["pending", "ocr_needed", "skipped_no_key"].includes(p.state),
    )
    .map((p) => p.page);
  const pagesOcrStampOnly = input.pages
    .filter((p) => p.state === "ocr_done" && p.ocr_yield === "stamp_only")
    .map((p) => p.page);

  const criticalOcrPagesByPiece = new Map<PageLedgerEntry["piece_type"], number[]>();
  for (const page of input.pages) {
    if (!OCR_NEEDED_STATES.has(page.state)) continue;
    if (!isPotentiallyCritical(page.piece_type, { unread: false })) continue;
    const current = criticalOcrPagesByPiece.get(page.piece_type) ?? [];
    current.push(page.page);
    criticalOcrPagesByPiece.set(page.piece_type, current);
  }

  const critical_gaps: CoverageManifest["critical_gaps"] = [];
  for (const [piece_type, pages] of criticalOcrPagesByPiece) {
    critical_gaps.push({
      kind: "critical_piece_incomplete",
      piece_type,
      pages,
      reason: "OCR pendente em paginas classificadas como peca critica",
    });
  }
  if (pagesUnknownUnread.length) {
    critical_gaps.push({
      kind: "unknown_unread_potentially_critical",
      piece_type: "unknown",
      pages: pagesUnknownUnread,
      reason: "Pagina nao lida sem classificacao confiavel",
    });
  }

  // Truncamento NUNCA é sucesso: páginas que o worker não chegou a extrair
  // (sem linha no ledger) bloqueiam análise global e aparecem com intervalo.
  const extracted = new Set(input.pages.map((p) => p.page));
  const missing: number[] = [];
  for (let page = 1; page <= input.total_pages; page++) {
    if (!extracted.has(page)) missing.push(page);
  }
  let pages_never_extracted: CoverageManifest["pages_never_extracted"];
  if (missing.length) {
    pages_never_extracted = {
      count: missing.length,
      intervalo: `${missing[0]}-${missing[missing.length - 1]}`,
    };
    critical_gaps.push({
      kind: "ingest_incomplete",
      piece_type: "unknown",
      // Só as bordas: listar milhares de páginas estouraria o payload.
      pages: [missing[0], missing[missing.length - 1]],
      reason: `O PDF tem ${input.total_pages} página(s) e apenas ${input.pages.length} foram lidas — retome a preparação.`,
    });
  }

  const warnings = critical_gaps.length
    ? ["Analise global bloqueada: ha paginas criticas ainda nao lidas."]
    : [];
  if (pagesOcrStampOnly.length) {
    // Não bloqueia a análise global (a página foi lida no melhor esforço),
    // mas o conteúdo fotografado pode não estar transcrito — honestidade > silêncio.
    warnings.push(
      `${pagesOcrStampOnly.length} pagina(s) escaneadas cuja leitura rendeu apenas os carimbos digitais (provavel foto/manuscrito nao transcrito); seguem localizaveis pela busca por significado — confira o original antes de usar como prova.`,
    );
  }

  return {
    case_id: input.case_id,
    total_pages: input.total_pages,
    pages_read: input.pages.filter((p) => READ_STATES.has(p.state)).length,
    pages_pending: pagesPending,
    pages_ocr_needed: pagesOcrNeeded,
    pages_ocr_done: pagesOcrDone,
    pages_failed_retryable: pagesFailedRetryable,
    pages_failed_permanent: pagesFailedPermanent,
    pages_ocr_stamp_only: pagesOcrStampOnly,
    pages_unknown_unread: pagesUnknownUnread,
    pages_never_extracted,
    ocr_estimate: input.ocr_estimate,
    critical_gaps,
    global_analysis_allowed: critical_gaps.length === 0,
    warnings,
  };
}
