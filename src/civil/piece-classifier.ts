import type { PieceType } from "../domain/types.js";
import { foldText } from "./text-fold.js";

export interface PieceClassificationInput {
  page: number;
  text: string;
  textReliable: boolean;
  metadataLabel?: string;
  previousPieceType?: PieceType;
}

export interface PieceClassification {
  piece_type: PieceType;
  piece_confidence: number;
  signals: string[];
}

const PATTERNS: Array<[PieceType, RegExp]> = [
  // Penal ANTES do cível genérico: "denuncia" não pode cair em "inicial".
  ["denuncia", /\bdenuncia\b/i],
  ["resposta_acusacao", /\bresposta a acusacao\b/i],
  ["alegacoes_finais", /\b(alegacoes finais|memoriais)\b/i],
  ["laudo", /\blaudo (pericial|de exame|toxicologico|cadaverico|necroscopico)\b/i],
  ["inicial", /\b(peticao inicial|inicial)\b/i],
  // "replica" antes de "contestacao": a impugnação à contestação cita a palavra
  // "contestacao" e seria engolida pelo padrão mais genérico.
  ["replica", /\b(replica|impugnacao a contestacao)\b/i],
  ["contestacao", /\bcontestacao\b/i],
  ["sentenca", /\bsentenca\b/i],
  ["decisao", /\b(decisao|despacho)\b/i],
  ["recurso", /\b(apelacao|agravo|recurso)\b/i],
  ["comprovante", /\b(comprovante|recibo|boleto|pix|pagamento)\b/i],
  ["procuracao", /\bprocuracao\b/i],
  ["documento_pessoal", /\b(rg|cpf|cnh|documento de identidade)\b/i],
];

export function classifyCivilPiece(input: PieceClassificationInput): PieceClassification {
  const haystack = foldText(`${input.metadataLabel ?? ""}\n${input.text}`.trim());
  if (!input.textReliable && !input.metadataLabel) {
    return { piece_type: "unknown", piece_confidence: 0.1, signals: ["unread_unknown"] };
  }

  for (const [piece_type, pattern] of PATTERNS) {
    if (pattern.test(haystack)) {
      return {
        piece_type,
        piece_confidence: input.textReliable ? 0.85 : 0.55,
        signals: [`regex:${piece_type}`],
      };
    }
  }

  if (input.previousPieceType && input.previousPieceType !== "unknown") {
    return {
      piece_type: input.previousPieceType,
      piece_confidence: 0.45,
      signals: ["neighbor_continuation"],
    };
  }

  return {
    piece_type: "unknown",
    piece_confidence: input.textReliable ? 0.35 : 0.1,
    signals: ["no_signal"],
  };
}

export function isPotentiallyCritical(pieceType: PieceType, opts: { unread: boolean }): boolean {
  if (opts.unread && pieceType === "unknown") return true;
  return [
    "inicial",
    "contestacao",
    "replica",
    "decisao",
    "sentenca",
    "recurso",
    "denuncia",
    "resposta_acusacao",
    "alegacoes_finais",
    "laudo",
  ].includes(
    pieceType,
  );
}
