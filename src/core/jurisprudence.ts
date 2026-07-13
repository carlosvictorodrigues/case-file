import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stableCaseId } from "../domain/evidence.js";
import { resolveInsideRoot } from "../storage/workspace.js";

export interface JurisprudenceDocumentInput {
  doc_id: string;
  titulo?: string;
  tribunal?: string;
  url?: string;
}

interface JurisprudenceBundleFile {
  documents: JurisprudenceDocumentInput[];
}

function bundlePath(root: string, caseId: string): string {
  return resolveInsideRoot(
    root,
    join(root, stableCaseId(caseId), "artifacts", "jurisprudence_bundle.json"),
  );
}

/**
 * Persiste (mesclando por doc_id) os documentos de jurisprudência que o
 * assistente recuperou do MCP de jurisprudência conectado no workspace.
 * Este registro local é a ÚNICA fonte que verificar_referencias aceita para
 * doc_ids — o chamador não pode auto-atestar um doc_id na hora da verificação.
 */
export function registerJurisprudence(
  root: string,
  caseId: string,
  documents: JurisprudenceDocumentInput[],
): { case_id: string; registered: number; total: number } {
  const path = bundlePath(root, caseId);
  mkdirSync(dirname(path), { recursive: true });

  const existing: JurisprudenceBundleFile = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as JurisprudenceBundleFile)
    : { documents: [] };

  const byId = new Map(
    (existing.documents ?? [])
      .filter((doc) => typeof doc?.doc_id === "string" && doc.doc_id.length > 0)
      .map((doc) => [doc.doc_id, doc]),
  );
  let registered = 0;
  for (const doc of documents) {
    if (!byId.has(doc.doc_id)) registered++;
    byId.set(doc.doc_id, { ...byId.get(doc.doc_id), ...doc });
  }

  const merged: JurisprudenceBundleFile = { documents: [...byId.values()] };
  writeFileSync(path, JSON.stringify(merged, null, 2));
  return {
    case_id: stableCaseId(caseId),
    registered,
    total: merged.documents.length,
  };
}
