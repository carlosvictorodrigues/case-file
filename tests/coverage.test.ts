import { describe, expect, it } from "vitest";
import { buildCoverageManifest } from "../src/core/coverage.js";
import type { PageLedgerEntry } from "../src/domain/types.js";

function entry(
  page: number,
  state: PageLedgerEntry["state"],
  piece_type: PageLedgerEntry["piece_type"],
): PageLedgerEntry {
  return {
    case_id: "caso",
    page,
    state,
    text_quality_reasons: [],
    native_text_chars: state === "pending" ? 0 : 100,
    piece_type,
    ocr_needed: state === "ocr_needed" || state === "skipped_no_key",
    ocr_attempts: 0,
    evidence_ids: [],
    updated_at: "2026-07-07T20:00:00.000Z",
  };
}

describe("buildCoverageManifest", () => {
  it("blocks global analysis for critical OCR gaps and unknown unread pages", () => {
    const manifest = buildCoverageManifest({
      case_id: "caso",
      total_pages: 3,
      pages: [
        entry(1, "done", "inicial"),
        entry(2, "ocr_needed", "contestacao"),
        entry(3, "pending", "unknown"),
      ],
      ocr_estimate: { pages: 1, calls: 1, requires_approval: false, approved: true },
    });

    expect(manifest.global_analysis_allowed).toBe(false);
    expect(manifest.critical_gaps.map((gap) => gap.kind)).toEqual([
      "critical_piece_incomplete",
      "unknown_unread_potentially_critical",
    ]);
    expect(manifest.pages_unknown_unread).toEqual([3]);
  });
});
