# Case File

Local-first MCP server que transforma um processo cível em um caso consultável, com proveniência estrutural: todo trecho nasce com `evidence_id`, página e hash, e nada deve ser afirmado sem passar por `verificar_referencias`.

## What It Does

- Creates a local workspace for a civil case PDF.
- Extracts text-native PDF pages.
- Runs BYOK Gemini OCR only within the approval gate (threshold + explicit page/call ceilings).
- Stores stable `evidence_id`s and page-level provenance.
- Builds a portable SQLite/FTS5 index.
- Produces compact evidence bundles for drafting, factual review, and jurisprudence research.
- Generates conservative civil procedural radar entries as candidates for lawyer review.
- Registers jurisprudence doc_ids retrieved by a separate jurisprudence MCP (`registrar_jurisprudencia`) so final reports can be verified.

This MVP does not include visual embeddings, final civil deadline calculations, or full pleading generation.

## Local Data Boundary

`CASE_FILE_CASES_DIR` is the only authorized case directory. Put the source PDF inside this directory before calling `criar_caso_local`; the server copies it into a per-case workspace and rejects paths outside the authorized root.

This package does not ask for credentials from any jurisprudence provider and does not call a jurisprudence service directly. If the user's AI workspace also has a jurisprudence MCP connected (if one is connected), the assistant uses that separate MCP for research and then persists the returned doc_ids locally via `registrar_jurisprudencia`.

## User Installation

The user-facing distribution target is a `.mcpb` bundle for Claude Desktop, not manual STDIO configuration.

Install options:

1. Double-click `case-file.mcpb`.
2. Drag `case-file.mcpb` into Claude Desktop.
3. Use Claude Desktop Settings > Extensions > Advanced settings > Install Extension.

During installation, Claude Desktop asks for:

- local cases directory;
- Gemini API key for OCR and future embeddings;
- optional OCR tuning values.

### Known benign warning

On some Windows machines the server logs a `canvas`/native-module load warning at startup. It is harmless: page rendering falls back to the bundled pure-JS path and every tool keeps working. No action needed.

## Support

- Issues and feedback: <https://github.com/carlosvictorodrigues/case-file/issues>
- Each release ships the ready-to-install `case-file.mcpb` under [Releases](https://github.com/carlosvictorodrigues/case-file/releases); install the newest one over the old version (settings are kept).

## Development

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run pack:mcpb
npm run verify:mcpb
```

`npm run pack:mcpb` writes `case-file.mcpb` at the repository root.

## Runtime Config

- `CASE_FILE_CASES_DIR`: required local directory for all case files and generated artifacts.
- Legacy `JUSRATIO_*` variable names from pre-1.0 installs are still accepted as fallbacks.
- `GEMINI_API_KEY`: recommended (BYOK) — used locally for OCR and semantic search. Without it, native PDFs work fully; scanned pages stay pending OCR (`retomar_ingestao` picks them up once the key is configured).
- `GEMINI_OCR_MODEL`: optional OCR model override. Default: `gemini-3.5-flash`.
- `GEMINI_EMBEDDING_MODEL`: optional embedding model override for semantic search. Default: `gemini-embedding-2`.
- `CASE_FILE_OCR_MAX_CONCURRENCY`: optional OCR concurrency limit. Default: `2`.
- `CASE_FILE_OCR_MAX_RETRY_ATTEMPTS`: optional per-page OCR retry limit. Default: `3`.
- `CASE_FILE_OCR_APPROVAL_PAGE_THRESHOLD`: pages of pending OCR above which explicit approval (`autorizar_ocr`) is required before any Gemini call. Default: `25`.

## Local Civil Workflow

1. Configure `CASE_FILE_CASES_DIR` to an authorized local folder.
2. Configure `GEMINI_API_KEY` for BYOK OCR.
3. Call `criar_caso_local` with `pdf_path`.
4. Call `status_caso` to inspect progress, pending OCR, locks, and coverage.
5. Use `autorizar_ocr` when the job pauses in `paused_awaiting_ocr_approval`; the approved `max_pages`/`max_calls` ceilings are enforced.
6. Use `retomar_ingestao` after restarting the client, configuring Gemini, or approving OCR — already-processed pages are never re-billed.
7. Optionally call `indexar_semantica` (explicit `max_calls` ceiling, BYOK) so `buscar_no_processo` becomes hybrid — lexical bm25 + local vector search fused by RRF.
8. Use `analisar_radar_processual_civel` for candidate procedural observations.
9. Use `montar_pacote_evidencias` or `analisar_caso_civel` for global work with explicit gaps.
10. After researching in the jurisprudence MCP, call `registrar_jurisprudencia` with the returned doc_ids, then `verificar_referencias` before the final report.

OCR is transcription. Always verify `image_ref` against the original document before using OCR text as evidence.

## License

Source code licensed under [Apache-2.0](LICENSE).
