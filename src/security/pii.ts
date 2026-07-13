import { foldText } from "../civil/text-fold.js";

const CNJ_RE = /\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}/g;
const CPF_RE = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g;
const CNPJ_RE = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove dados pessoais de texto destinado a sair do ambiente local (ex.:
 * queries de jurisprudência para um MCP remoto): nomes das partes, CPF/CNPJ,
 * número CNJ e e-mails. Minimização — o precedente não precisa do nome.
 */
export function stripPersonalData(text: string, partyNames: string[] = []): string {
  let out = text
    .replace(CNJ_RE, "[processo]")
    .replace(CNPJ_RE, "[cnpj]")
    .replace(CPF_RE, "[cpf]")
    .replace(EMAIL_RE, "[email]");

  for (const name of partyNames) {
    const trimmed = name.trim();
    if (trimmed.length < 4) continue;
    for (const variant of new Set([trimmed, foldText(trimmed)])) {
      out = out.replace(new RegExp(escapeRegex(variant), "gi"), "[parte]");
    }
  }
  return out.replace(/\s{2,}/g, " ").trim();
}
