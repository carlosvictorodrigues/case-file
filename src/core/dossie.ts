import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CaseIndex } from "../storage/index-db.js";
import { resolveInsideRoot } from "../storage/workspace.js";
import { stableCaseId } from "../domain/evidence.js";

/**
 * Dossiê persistente: o estado da INVESTIGAÇÃO vive no workspace do caso,
 * não na conversa. A janela de contexto do cliente pode compactar/esquecer
 * à vontade — uma chamada de `dossie` restaura todos os achados, cada um
 * com o seu lastro (evidence_ids validados contra o índice no registro).
 * Também é o que permite retomar a investigação em OUTRA sessão/dia.
 */

export interface DossieAchado {
  achado_id: string;
  achado: string;
  evidence_ids: string[];
  registrado_em: string;
}

export interface DossieView {
  case_id: string;
  total: number;
  achados: DossieAchado[];
  aviso: string;
}

const MAX_ACHADO_CHARS = 600;
const MAX_ACHADOS = 500;

function caseDirOrThrow(root: string, caseId: string): string {
  const normalized = stableCaseId(caseId);
  const caseDir = resolveInsideRoot(root, join(root, normalized));
  if (!existsSync(caseDir)) {
    throw new Error(`ENOENT: case not found, open '${caseDir}'`);
  }
  return caseDir;
}

function dossiePath(root: string, caseId: string): string {
  return join(caseDirOrThrow(root, caseId), "artifacts", "dossie.json");
}

function readDossie(path: string): DossieAchado[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return Array.isArray(parsed) ? (parsed as DossieAchado[]) : [];
}

export async function registrarAchado(
  root: string,
  caseId: string,
  achado: string,
  evidenceIds: string[],
): Promise<{ achado_id: string; total: number; aviso?: string }> {
  const texto = achado.trim();
  if (!texto) {
    throw new Error("Achado vazio: descreva o fato apurado em uma ou duas frases.");
  }
  if (!evidenceIds.length) {
    throw new Error(
      "Achado sem lastro: informe ao menos um evidence_id (regra central do produto).",
    );
  }

  // Lastro é VALIDADO no registro — um achado com evidence_id inexistente
  // seria exatamente a alucinação que o produto existe para impedir.
  const db = join(caseDirOrThrow(root, caseId), "index", "case.sqlite");
  const index = await CaseIndex.open(db, root);
  try {
    for (const id of evidenceIds) {
      if (!index.getEvidence(id)) {
        throw new Error(
          `evidence_id desconhecido neste caso: ${id}. Use IDs devolvidos por buscar_no_processo/ler_original.`,
        );
      }
    }
  } finally {
    index.close();
  }

  const path = dossiePath(root, caseId);
  const achados = readDossie(path);
  if (achados.length >= MAX_ACHADOS) {
    throw new Error(`Dossiê cheio (${MAX_ACHADOS} achados); consolide antes de registrar novos.`);
  }

  const clipped = texto.length > MAX_ACHADO_CHARS ? `${texto.slice(0, MAX_ACHADO_CHARS)} …` : texto;
  const achadoId = `ach-${createHash("sha256")
    .update(`${clipped}|${evidenceIds.join(",")}`)
    .digest("hex")
    .slice(0, 12)}`;

  // Idempotente: registrar o mesmo achado duas vezes não duplica.
  if (!achados.some((item) => item.achado_id === achadoId)) {
    achados.push({
      achado_id: achadoId,
      achado: clipped,
      evidence_ids: evidenceIds,
      registrado_em: new Date().toISOString(),
    });
    writeFileSync(path, JSON.stringify(achados, null, 2));
  }

  return {
    achado_id: achadoId,
    total: achados.length,
    aviso: texto.length > MAX_ACHADO_CHARS ? "Achado truncado; registre fatos curtos." : undefined,
  };
}

export function lerDossie(root: string, caseId: string): DossieView {
  const achados = readDossie(dossiePath(root, caseId));
  return {
    case_id: stableCaseId(caseId),
    total: achados.length,
    achados,
    aviso:
      "Estado persistente da investigacao. Antes de citar um achado em relatorio, reabra o verbatim com ler_original e valide com verificar_referencias (modo claims).",
  };
}
