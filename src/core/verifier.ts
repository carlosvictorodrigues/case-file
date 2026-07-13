import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foldText } from "../civil/text-fold.js";
import { stableCaseId } from "../domain/evidence.js";
import { resolveInsideRoot } from "../storage/workspace.js";
import { openEvidence } from "./case-service.js";

export interface ClaimSupport {
  evidence_id: string;
  /** Trecho LITERAL copiado do verbatim — validado por substring normalizada. */
  trecho_base: string;
}

export interface Claim {
  claim_id?: string;
  afirmacao: string;
  supports: ClaimSupport[];
  doc_ids?: string[];
}

export type ClaimStatus =
  | "ok"
  | "evidencia_inexistente"
  | "trecho_nao_encontrado"
  | "literal_nao_suportado"
  | "doc_id_nao_registrado";

export interface ClaimResult {
  claim_id?: string;
  afirmacao: string;
  status: ClaimStatus;
  problemas: string[];
  supports: Array<{
    evidence_id: string;
    ok: boolean;
    citacao?: string;
    page?: number;
  }>;
}

export interface ReferenceInput {
  evidence_ids?: string[];
  doc_ids?: string[];
  jurisprudence_doc_ids?: string[];
  claims?: Claim[];
}

export interface VerificationResult {
  ok: boolean;
  missing_evidence_ids: string[];
  missing_doc_ids: string[];
  claims?: ClaimResult[];
  errors: string[];
}

interface JurisprudenceBundleDocument {
  doc_id?: unknown;
}

interface JurisprudenceBundle {
  documents?: JurisprudenceBundleDocument[];
}

function loadLocalJurisprudenceDocIds(
  root: string,
  caseId: string,
): { ids: Set<string>; bundleExists: boolean } {
  const normalizedCaseId = stableCaseId(caseId);
  const artifactPath = resolveInsideRoot(
    root,
    join(root, normalizedCaseId, "artifacts", "jurisprudence_bundle.json"),
  );

  try {
    const raw = JSON.parse(readFileSync(artifactPath, "utf8")) as JurisprudenceBundle;
    return {
      bundleExists: true,
      ids: new Set(
        (raw.documents ?? [])
          .map((document) => document.doc_id)
          .filter((docId): docId is string => typeof docId === "string" && docId.length > 0),
      ),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ids: new Set(), bundleExists: false };
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Normalização p/ comparação de trecho: fold (acentos/caixa) + espaços colapsados. */
function normalizeForMatch(text: string): string {
  return foldText(text).replace(/\s+/g, " ").trim();
}

/**
 * Literais de ALTO RISCO da afirmação (datas, valores em R$, percentuais e
 * números CNJ): cada um precisa aparecer em algum trecho_base do claim.
 * É o que impede a alucinação clássica de "data/valor quase certo".
 */
const LITERAL_PATTERNS: RegExp[] = [
  /\d{2}\/\d{2}\/\d{4}/g, // datas dd/mm/aaaa
  /\d{4}-\d{2}-\d{2}/g, // datas ISO
  /R\$\s?[\d.]+(?:,\d{2})?/g, // valores monetários
  /\d+(?:,\d+)?\s?%/g, // percentuais
  /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/g, // número CNJ
];

function extractLiterals(text: string): string[] {
  const literals: string[] = [];
  for (const pattern of LITERAL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      literals.push(match[0]);
    }
  }
  return literals;
}

/**
 * Validação POR AFIRMAÇÃO (decisão do brainstorm P13): determinística, sem
 * "entailment" semântico — o servidor confere que o trecho_base é substring
 * REAL do verbatim (o modelo não consegue inventar citação e colar um ID
 * válido) e que os literais de risco da afirmação constam do lastro. A
 * adequação jurídica afirmação↔trecho continua sendo julgamento do modelo.
 */
async function verifyClaims(
  root: string,
  caseId: string,
  claims: Claim[],
  registeredDocs: Set<string>,
  bundleExists: boolean,
): Promise<ClaimResult[]> {
  const results: ClaimResult[] = [];
  for (const claim of claims) {
    const problemas: string[] = [];
    const supports: ClaimResult["supports"] = [];
    let status: ClaimStatus = "ok";
    const trechosValidos: string[] = [];

    for (const support of claim.supports ?? []) {
      try {
        const unit = await openEvidence(root, caseId, support.evidence_id);
        const verbatim = normalizeForMatch(unit.text ?? "");
        const trecho = normalizeForMatch(support.trecho_base ?? "");
        if (!trecho || !verbatim.includes(trecho)) {
          status = "trecho_nao_encontrado";
          problemas.push(
            `trecho_base não consta do verbatim de ${support.evidence_id} — copie o trecho LITERAL da evidência.`,
          );
          supports.push({ evidence_id: support.evidence_id, ok: false });
          continue;
        }
        trechosValidos.push(trecho);
        supports.push({
          evidence_id: support.evidence_id,
          ok: true,
          citacao: unit.documento?.citacao,
          page: unit.page,
        });
      } catch {
        status = "evidencia_inexistente";
        problemas.push(`evidence_id desconhecido: ${support.evidence_id}`);
        supports.push({ evidence_id: support.evidence_id, ok: false });
      }
    }

    if (!claim.supports?.length) {
      status = "evidencia_inexistente";
      problemas.push("Claim sem supports: toda afirmação precisa de ao menos um trecho com lastro.");
    }

    if (status === "ok") {
      const lastro = trechosValidos.join(" ");
      const faltantes = extractLiterals(claim.afirmacao).filter(
        (literal) => !lastro.includes(normalizeForMatch(literal)),
      );
      if (faltantes.length) {
        status = "literal_nao_suportado";
        problemas.push(
          `Literal(is) da afirmação sem lastro nos trechos: ${faltantes.join("; ")} — confira data/valor/nº no verbatim.`,
        );
      }
    }

    if (status === "ok" && claim.doc_ids?.length) {
      const naoRegistrados = claim.doc_ids.filter((id) => !registeredDocs.has(id));
      if (naoRegistrados.length) {
        status = "doc_id_nao_registrado";
        problemas.push(
          bundleExists
            ? `Precedente(s) não registrados: ${naoRegistrados.join(", ")} — registre via registrar_jurisprudencia.`
            : "Nenhuma jurisprudência registrada neste caso; registre via registrar_jurisprudencia antes de citar precedentes.",
        );
      }
    }

    results.push({
      claim_id: claim.claim_id,
      afirmacao: claim.afirmacao,
      status,
      problemas,
      supports,
    });
  }
  return results;
}

export async function verifyReferences(
  root: string,
  caseId: string,
  input: ReferenceInput,
): Promise<VerificationResult> {
  const missingEvidence: string[] = [];
  const errors: string[] = [];
  for (const id of input.evidence_ids ?? []) {
    try {
      await openEvidence(root, caseId, id);
    } catch (error) {
      const message = errorMessage(error);
      if (message === `evidence_id not found: ${id}`) {
        missingEvidence.push(id);
        continue;
      }
      errors.push(`evidence_id ${id}: ${message}`);
    }
  }

  let allowedDocs = new Set<string>();
  let bundleExists = false;
  try {
    const loaded = loadLocalJurisprudenceDocIds(root, caseId);
    allowedDocs = loaded.ids;
    bundleExists = loaded.bundleExists;
  } catch (error) {
    errors.push(`jurisprudence_bundle: ${errorMessage(error)}`);
  }
  const missingDocIds = (input.doc_ids ?? []).filter((id) => !allowedDocs.has(id));
  if (missingDocIds.length && !bundleExists) {
    // Sem registro local não há como validar NENHUM doc_id — oriente o fluxo
    // em vez de só reprovar: pesquisou no MCP de jurisprudência, registre.
    errors.push(
      "Nenhuma jurisprudencia registrada neste caso; apos pesquisar no MCP de jurisprudencia, chame registrar_jurisprudencia com os doc_ids reais antes de verificar.",
    );
  }

  const claims = input.claims?.length
    ? await verifyClaims(root, caseId, input.claims, allowedDocs, bundleExists)
    : undefined;
  const claimsOk = !claims || claims.every((claim) => claim.status === "ok");

  return {
    ok:
      missingEvidence.length === 0 &&
      missingDocIds.length === 0 &&
      errors.length === 0 &&
      claimsOk,
    missing_evidence_ids: missingEvidence,
    missing_doc_ids: missingDocIds,
    claims,
    errors,
  };
}
