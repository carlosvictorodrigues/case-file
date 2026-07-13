import { createHash } from "node:crypto";
import type { EvidenceUnit } from "./types.js";

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function evidenceId(caseId: string, page: number, unitId: string): string {
  return `case:${caseId}:page:${page}:unit:${unitId}`;
}

export function stableCaseId(inputPath: string): string {
  // Sem path.basename: em POSIX o "\" n\u00e3o \u00e9 separador, ent\u00e3o um slug vindo
  // de Windows ("..\\..\\escape") sanitizaria diferente por plataforma.
  const lastSegment = inputPath.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const base = lastSegment.replace(/\.[A-Za-z0-9]+$/, "").toLowerCase();
  return base
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "caso";
}

export function displayRef(unit: EvidenceUnit): string {
  if (unit.display_ref?.trim()) return unit.display_ref.trim();
  if (unit.event_id && unit.folio_label) return `${unit.event_id}, ${unit.folio_label}`;
  if (unit.folio_label) return unit.folio_label;
  if (unit.event_id) return unit.event_id;
  return `pagina ${unit.page} do PDF`;
}

export function stableEventSignature(input: {
  case_id: string;
  tipo: string;
  subtipo?: string;
  modalidade?: string;
  data?: string;
  canonical_evidence_id: string;
  canonical_text_hash: string;
}): string {
  const page = input.canonical_evidence_id.match(/:page:(\d+):/)?.[1] ?? "unknown";
  return [
    input.case_id,
    normalizeSignaturePart(input.tipo),
    normalizeSignaturePart(input.subtipo ?? "unknown"),
    normalizeSignaturePart(input.modalidade ?? "unknown"),
    input.data ?? "unknown",
    page,
    input.canonical_text_hash.slice(0, 12),
  ].join("|");
}

function normalizeSignaturePart(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unknown"
  );
}
