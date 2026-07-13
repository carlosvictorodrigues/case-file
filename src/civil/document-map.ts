import type { EvidenceUnit, PageLedgerEntry, PieceType } from "../domain/types.js";

/**
 * Mapa do caderno processual: o processo não é uma pilha de páginas, é um
 * conjunto de DOCUMENTOS (peças, contratos, certidões). No PJe, o rodapé de
 * cada página carrega o identificador do documento (Num.), o assinante e a
 * data de assinatura — o índice dos autos inteiro, determinístico e local.
 * Isso permite distinguir fonte primária de menção, atribuir alegações à
 * peça/parte correta e datar juntadas sem inferência.
 */

export interface PjeFooterInfo {
  doc_num: string;
  doc_internal_page?: number;
  signer?: string;
  signed_date?: string; // ISO yyyy-mm-dd
}

/**
 * Sistema de origem do caderno, detectado pelos carimbos que ele imprime.
 * A citação forense segue o padrão do sistema: no gabinete não se cita
 * "página do PDF" — cita-se (ID, pág.) no PJe, (evento, DOC, fl.) no eproc
 * e (e-STJ, fl.) no STJ. "desconhecido" = sem carimbo reconhecido; a
 * citação cai para página global do PDF, sempre rotulada.
 */
export type SourceSystem = "pje" | "eproc" | "estj" | "desconhecido";

export interface CaseDocument {
  num: string;
  first_page: number;
  last_page: number;
  pages: number;
  /** Data de assinatura eletrônica no rodapé (≈ juntada), ISO. */
  signed_date?: string;
  signer?: string;
  /** Tipo classificado pela PRIMEIRA página do documento; continuações herdam. */
  piece_type: PieceType;
  /** eproc: número do evento e rótulo do documento (ex.: evento 12, PET1). */
  evento?: string;
  rotulo?: string;
}

export interface DocumentMap {
  /** Ausente em artefatos antigos (pré-v0.10) = "pje". */
  sistema?: SourceSystem;
  total_documentos: number;
  paginas_mapeadas: number;
  paginas_sem_documento: number[];
  documentos: CaseDocument[];
  /** e-STJ: folha carimbada por página global do PDF (chave = página). */
  folhas_estj?: Record<string, number>;
  /**
   * eproc: página INTERNA carimbada no cabeçalho ("... / Página N"), por
   * página global. Quando presente, vence a contiguidade na citação — a
   * capa separadora de evento não corrompe a numeração.
   */
  paginas_internas_eproc?: Record<string, number>;
}

const NUM_RE = /Num\.\s*(\d+)\s*-\s*P[áa]g\.\s*(\d+)/u;
const SIGNED_RE = /Assinado eletronicamente por:\s*(.+?)\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/u;

export function parsePjeFooter(text: string): PjeFooterInfo | undefined {
  const num = NUM_RE.exec(text);
  if (!num) return undefined;
  const info: PjeFooterInfo = {
    doc_num: num[1],
    doc_internal_page: Number(num[2]),
  };
  const signed = SIGNED_RE.exec(text);
  if (signed) {
    info.signer = signed[1].trim().slice(0, 80);
    info.signed_date = `${signed[4]}-${signed[3]}-${signed[2]}`;
  }
  return info;
}

/** Carimbo de folha do e-STJ, impresso em cada página da íntegra. */
const ESTJ_RE = /e-STJ\s+Fl\.?\s*(\d{1,6})/iu;

export function parseEstjFolha(text: string): number | undefined {
  const match = ESTJ_RE.exec(text);
  return match ? Number(match[1]) : undefined;
}

export function buildDocumentMap(
  units: EvidenceUnit[],
  ledger: PageLedgerEntry[],
): DocumentMap {
  const pageUnits = units
    .filter((unit) => unit.unit_type === "page_text")
    .sort((a, b) => a.page - b.page);

  // Ordem de detecção: PJe (comportamento original, byte-idêntico quando há
  // rodapé) → eproc → e-STJ. Cada parser só "vence" com cobertura mínima,
  // para um carimbo citado DENTRO de uma peça não rotular o caderno inteiro.
  const pje = buildPjeMap(pageUnits, ledger);
  if (pje.total_documentos > 0) {
    return { sistema: "pje", ...pje };
  }

  const eproc = buildEprocMap(pageUnits, ledger);
  if (eproc && eproc.total_documentos > 0) {
    return { sistema: "eproc", ...eproc };
  }

  const folhas = buildEstjFolhas(pageUnits);
  if (folhas) {
    return {
      sistema: "estj",
      total_documentos: 0,
      paginas_mapeadas: Object.keys(folhas).length,
      paginas_sem_documento: pageUnits
        .filter((unit) => folhas[String(unit.page)] === undefined)
        .map((unit) => unit.page),
      documentos: [],
      folhas_estj: folhas,
    };
  }

  return {
    sistema: "desconhecido",
    total_documentos: 0,
    paginas_mapeadas: 0,
    paginas_sem_documento: pageUnits.map((unit) => unit.page),
    documentos: [],
  };
}

function buildPjeMap(
  pageUnits: EvidenceUnit[],
  ledger: PageLedgerEntry[],
): Omit<DocumentMap, "sistema"> {
  const pieceByPage = new Map(ledger.map((entry) => [entry.page, entry.piece_type]));
  const byNum = new Map<string, CaseDocument>();
  const unmapped: number[] = [];

  for (const unit of pageUnits) {
    const footer = parsePjeFooter(unit.text ?? "");
    if (!footer) {
      unmapped.push(unit.page);
      continue;
    }
    const existing = byNum.get(footer.doc_num);
    if (!existing) {
      byNum.set(footer.doc_num, {
        num: footer.doc_num,
        first_page: unit.page,
        last_page: unit.page,
        pages: 1,
        signed_date: footer.signed_date,
        signer: footer.signer,
        piece_type: pieceByPage.get(unit.page) ?? "unknown",
      });
    } else {
      existing.first_page = Math.min(existing.first_page, unit.page);
      existing.last_page = Math.max(existing.last_page, unit.page);
      existing.pages += 1;
      if (!existing.signed_date && footer.signed_date) existing.signed_date = footer.signed_date;
      if (!existing.signer && footer.signer) existing.signer = footer.signer;
    }
  }

  const documentos = [...byNum.values()].sort((a, b) => a.first_page - b.first_page);
  return {
    total_documentos: documentos.length,
    paginas_mapeadas: pageUnits.length - unmapped.length,
    paginas_sem_documento: unmapped,
    documentos,
  };
}

/**
 * eproc (TRF4/TJSC/TJRS/TJTO): a íntegra identifica cada documento por
 * "Evento N" + rótulo codificado (PET1, SENT1, DESPADEC1...). Parser
 * CONSERVADOR: só rotula o caderno quando o padrão se comporta como carimbo
 * (recorrente página a página), nunca por menção avulsa dentro de uma peça
 * ("conforme evento 12..."). Formato aguarda validação com íntegra real de
 * campo; na dúvida cai para "desconhecido" (citação por página do PDF
 * rotulada) — citação ausente é falha segura, citação errada não.
 */
const EPROC_PAGE_RE =
  /\bEvento\s+(\d{1,4})\s*[-–,]?\s*([A-Z][A-Z0-9]{1,14}\d{1,3})\b(?:\s*[\/|-]?\s*P[áa]gina\s+(\d{1,5})\b)?/u;
const EPROC_MIN_PAGES = 3;
const EPROC_MIN_COVERAGE = 0.3;

function buildEprocMap(
  pageUnits: EvidenceUnit[],
  ledger: PageLedgerEntry[],
): Omit<DocumentMap, "sistema"> | undefined {
  const pieceByPage = new Map(ledger.map((entry) => [entry.page, entry.piece_type]));
  const byKey = new Map<string, CaseDocument>();
  const unmapped: number[] = [];
  const paginasInternas: Record<string, number> = {};

  for (const unit of pageUnits) {
    const match = EPROC_PAGE_RE.exec(unit.text ?? "");
    if (!match) {
      unmapped.push(unit.page);
      continue;
    }
    const [, evento, rotulo, paginaInterna] = match;
    if (paginaInterna) paginasInternas[String(unit.page)] = Number(paginaInterna);
    const key = `${evento}:${rotulo}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        num: key,
        evento,
        rotulo,
        first_page: unit.page,
        last_page: unit.page,
        pages: 1,
        piece_type: pieceByPage.get(unit.page) ?? "unknown",
      });
    } else {
      existing.first_page = Math.min(existing.first_page, unit.page);
      existing.last_page = Math.max(existing.last_page, unit.page);
      existing.pages += 1;
    }
  }

  const mapped = pageUnits.length - unmapped.length;
  if (mapped < EPROC_MIN_PAGES || mapped < pageUnits.length * EPROC_MIN_COVERAGE) {
    return undefined;
  }

  const documentos = [...byKey.values()].sort((a, b) => a.first_page - b.first_page);
  return {
    total_documentos: documentos.length,
    paginas_mapeadas: mapped,
    paginas_sem_documento: unmapped,
    documentos,
    paginas_internas_eproc: Object.keys(paginasInternas).length ? paginasInternas : undefined,
  };
}

/** Página interna carimbada no cabeçalho eproc, se houver. */
export function findPaginaInternaEproc(
  map: DocumentMap | undefined,
  page: number,
): number | undefined {
  return map?.paginas_internas_eproc?.[String(page)];
}

/** Cobertura mínima para aceitar o carimbo e-STJ como identidade do caderno. */
const ESTJ_MIN_PAGES = 3;
const ESTJ_MIN_COVERAGE = 0.2;

function buildEstjFolhas(pageUnits: EvidenceUnit[]): Record<string, number> | undefined {
  const folhas: Record<string, number> = {};
  for (const unit of pageUnits) {
    const folha = parseEstjFolha(unit.text ?? "");
    if (folha !== undefined) folhas[String(unit.page)] = folha;
  }
  const hits = Object.keys(folhas).length;
  if (hits < ESTJ_MIN_PAGES || hits < pageUnits.length * ESTJ_MIN_COVERAGE) return undefined;
  return folhas;
}

/** Folha e-STJ carimbada na página global, se o caderno for do e-STJ. */
export function findFolhaEstj(map: DocumentMap | undefined, page: number): number | undefined {
  return map?.folhas_estj?.[String(page)];
}

/** Citação do documento no padrão do sistema de origem (praxe de gabinete). */
export function citeDocument(doc: CaseDocument): string {
  return doc.evento ? `Evento ${doc.evento}, ${doc.rotulo ?? doc.num}` : `ID ${doc.num}`;
}

/** Localiza o documento que contém a página (intervalos ordenados). */
export function findDocumentForPage(
  map: DocumentMap | undefined,
  page: number,
): CaseDocument | undefined {
  if (!map) return undefined;
  return map.documentos.find((doc) => page >= doc.first_page && page <= doc.last_page);
}
