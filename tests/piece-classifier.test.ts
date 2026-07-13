import { describe, expect, it } from "vitest";
import { classifyCivilPiece, isPotentiallyCritical } from "../src/civil/piece-classifier.js";

describe("classifyCivilPiece", () => {
  it("classifies common civil pieces from trusted text", () => {
    expect(classifyCivilPiece({ page: 1, text: "PETICAO INICIAL", textReliable: true })).toMatchObject({
      piece_type: "inicial",
    });
    expect(classifyCivilPiece({ page: 2, text: "CONTESTACAO com preliminar de prescricao", textReliable: true })).toMatchObject({
      piece_type: "contestacao",
    });
    expect(classifyCivilPiece({ page: 3, text: "SENTENCA julgo procedente", textReliable: true })).toMatchObject({
      piece_type: "sentenca",
    });
  });

  it("classifies real accented Portuguese pieces", () => {
    expect(classifyCivilPiece({ page: 1, text: "PETIÇÃO INICIAL", textReliable: true })).toMatchObject({
      piece_type: "inicial",
    });
    expect(classifyCivilPiece({ page: 2, text: "CONTESTAÇÃO com preliminar de prescrição", textReliable: true })).toMatchObject({
      piece_type: "contestacao",
    });
    expect(classifyCivilPiece({ page: 3, text: "SENTENÇA: julgo procedente o pedido", textReliable: true })).toMatchObject({
      piece_type: "sentenca",
    });
    expect(classifyCivilPiece({ page: 4, text: "PROCURAÇÃO ad judicia", textReliable: true })).toMatchObject({
      piece_type: "procuracao",
    });
    expect(classifyCivilPiece({ page: 5, text: "RÉPLICA — impugnação à contestação", textReliable: true })).toMatchObject({
      piece_type: "replica",
    });
    expect(classifyCivilPiece({ page: 6, text: "APELAÇÃO da parte ré", textReliable: true })).toMatchObject({
      piece_type: "recurso",
    });
  });

  it("treats unread unknown pages as potentially critical", () => {
    const result = classifyCivilPiece({ page: 9, text: "", textReliable: false });
    expect(result).toMatchObject({ piece_type: "unknown" });
    expect(isPotentiallyCritical(result.piece_type, { unread: true })).toBe(true);
  });
});
