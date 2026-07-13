import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { foldText } from "../civil/text-fold.js";
import { stableCaseId } from "../domain/evidence.js";
import { resolveInsideRoot } from "../storage/workspace.js";
import { defaultOpener, type LocalOpener } from "./open-local.js";

/**
 * Entregável de advogado é WORD, não markdown — e Word com FORMATAÇÃO
 * FORENSE (achado de campo: o default do docx saía Calibri azul com
 * bullets, "nada profissional"). Template embutido: A4, margens de
 * petição (3cm sup/esq, 2cm inf/dir), Times New Roman 12 preto,
 * justificado, entrelinha 1,5; títulos pretos em negrito; parágrafo
 * numerado ("1. ...") é PROSA justificada, nunca bullet; citação longa
 * em recuo de 4cm (ABNT) com corpo menor.
 *
 * O parser cobre o SUBSET que os relatórios usam; sintaxe desconhecida
 * degrada para parágrafo simples — nunca falha por causa de formatação.
 */

// Twips: 1cm = 567. A4 = 21 × 29,7cm.
const A4 = { width: 11906, height: 16838 };
const MARGENS = { top: 1701, left: 1701, right: 1134, bottom: 1134 };
const RECUO_CITACAO = 2268; // 4cm — citação longa (ABNT)
const FONTE = "Times New Roman";
const CORPO = 24; // 12pt em half-points
const CORPO_CITACAO = 22; // 11pt
const ENTRELINHA_15 = 360;

export interface ExportResult {
  case_id: string;
  arquivo: string;
  link: string;
  formato: "docx";
  /** true = pedimos ao sistema para abrir; NÃO garante que abriu (headless/WSL). */
  abertura_solicitada: boolean;
  aviso: string;
}

export async function exportarDocumento(
  root: string,
  caseId: string,
  titulo: string,
  conteudoMarkdown: string,
  options: { abrir?: boolean; opener?: LocalOpener } = {},
): Promise<ExportResult> {
  const normalized = stableCaseId(caseId);
  const caseDir = resolveInsideRoot(root, join(root, normalized));
  if (!existsSync(caseDir)) {
    throw new Error(`ENOENT: case not found, open '${caseDir}'`);
  }
  if (!titulo.trim()) {
    throw new Error("Informe um titulo para o documento.");
  }
  if (!conteudoMarkdown.trim()) {
    throw new Error("Conteudo vazio: envie o markdown do documento.");
  }

  const buffer = await markdownToDocxBuffer(titulo.trim(), conteudoMarkdown);
  const exportsDir = resolveInsideRoot(root, join(caseDir, "exports"));
  mkdirSync(exportsDir, { recursive: true });

  const stamp = new Date();
  const data = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, "0")}${String(
    stamp.getDate(),
  ).padStart(2, "0")}-${String(stamp.getHours()).padStart(2, "0")}${String(
    stamp.getMinutes(),
  ).padStart(2, "0")}`;
  const arquivo = resolveInsideRoot(root, join(exportsDir, `${slugify(titulo)}-${data}.docx`));
  writeFileSync(arquivo, buffer);

  const abrir = options.abrir ?? true;
  if (abrir) {
    (options.opener ?? defaultOpener)(arquivo, false);
  }

  return {
    case_id: normalized,
    arquivo,
    link: pathToFileURL(arquivo).href,
    formato: "docx",
    abertura_solicitada: abrir,
    aviso:
      "Documento gravado em exports/ do caso. A abertura na tela foi SOLICITADA ao sistema, mas pode nao acontecer (ex.: WSL/servidor sem interface grafica) - se nao abrir, use o caminho em 'arquivo'. Conteudo gerado por assistente: revise e confira as referencias no original antes de protocolar.",
  };
}

function slugify(titulo: string): string {
  const slug = foldText(titulo)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "documento";
}

export async function markdownToDocxBuffer(titulo: string, markdown: string): Promise<Buffer> {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const children: Array<Paragraph | Table> = [];

  // Título automático SÓ quando o markdown não abre com um título próprio —
  // senão o documento sai com título duplicado (achado de campo).
  const primeiraLinha = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
  if (!/^#{1,2}\s/.test(primeiraLinha)) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: titulo })],
      }),
    );
  }

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed || /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      index++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const levels = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
        HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6,
      ] as const;
      children.push(
        new Paragraph({
          heading: levels[Math.min(heading[1].length, 6) - 1],
          children: inlineRuns(heading[2]),
        }),
      );
      index++;
      continue;
    }

    // Tabela: linha começando com | seguida da régua |---|
    if (trimmed.startsWith("|") && /^\|?[\s:|-]+\|?$/.test((lines[index + 1] ?? "").trim())) {
      const tableLines: string[] = [trimmed];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trim().startsWith("|")) {
        tableLines.push(lines[cursor].trim());
        cursor++;
      }
      children.push(buildTable(tableLines));
      index = cursor;
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          alignment: AlignmentType.JUSTIFIED,
          spacing: { line: ENTRELINHA_15, after: 60 },
          children: inlineRuns(bullet[1]),
        }),
      );
      index++;
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      // Citação longa (ABNT): recuo de 4cm, corpo menor, entrelinha simples.
      const quoteLines: string[] = [quote[1]];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const next = /^>\s?(.*)$/.exec(lines[cursor].trim());
        if (!next) break;
        quoteLines.push(next[1]);
        cursor++;
      }
      children.push(
        new Paragraph({
          indent: { left: RECUO_CITACAO },
          alignment: AlignmentType.JUSTIFIED,
          spacing: { after: 120 },
          children: inlineRuns(quoteLines.join(" ")).map(
            (run) => new TextRun({ ...runOptionsOf(run), size: CORPO_CITACAO }),
          ),
        }),
      );
      index = cursor;
      continue;
    }

    // Parágrafo (inclui o numerado "1. ..." — PROSA forense justificada,
    // nunca bullet): junta linhas contíguas até quebra ou marcador.
    const buffer: string[] = [trimmed];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const next = lines[cursor].trim();
      if (!next || /^(#{1,6})\s|^[-*+]\s|^>|^\|/.test(next) || /^\d+[.)]\s/.test(next)) break;
      buffer.push(next);
      cursor++;
    }
    children.push(
      new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        spacing: { line: ENTRELINHA_15, after: 120 },
        children: inlineRuns(buffer.join(" ")),
      }),
    );
    index = cursor;
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: FONTE, size: CORPO, color: "000000" } },
      },
      paragraphStyles: [
        {
          id: "Title",
          name: "Title",
          basedOn: "Normal",
          run: { font: FONTE, size: 28, bold: true, color: "000000" },
          paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 360 } },
        },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          run: { font: FONTE, size: 26, bold: true, color: "000000" },
          paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 360, after: 240 } },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          run: { font: FONTE, size: CORPO, bold: true, color: "000000" },
          paragraph: { spacing: { before: 240, after: 120 } },
        },
        {
          id: "Heading3",
          name: "Heading 3",
          basedOn: "Normal",
          next: "Normal",
          run: { font: FONTE, size: CORPO, bold: true, italics: true, color: "000000" },
          paragraph: { spacing: { before: 240, after: 120 } },
        },
        {
          id: "Heading4",
          name: "Heading 4",
          basedOn: "Normal",
          next: "Normal",
          run: { font: FONTE, size: CORPO, bold: true, color: "000000" },
          paragraph: { spacing: { before: 120, after: 120 } },
        },
      ],
    },
    sections: [
      {
        properties: { page: { size: A4, margin: MARGENS } },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/** Extrai as opções de um TextRun para reconstruí-lo com overrides. */
function runOptionsOf(run: TextRun): { text: string; bold?: boolean; italics?: boolean; font?: string } {
  // docx não expõe getters públicos; guardamos as opções no factory abaixo.
  const meta = runMeta.get(run);
  return meta ?? { text: "" };
}

const runMeta = new WeakMap<
  TextRun,
  { text: string; bold?: boolean; italics?: boolean; font?: string }
>();

function makeRun(options: {
  text: string;
  bold?: boolean;
  italics?: boolean;
  font?: string;
  size?: number;
}): TextRun {
  const run = new TextRun(options);
  runMeta.set(run, options);
  return run;
}

/** Runs inline: **negrito**, *itálico* e `código` (subset; resto vira texto). */
function inlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) runs.push(makeRun({ text: text.slice(last, start) }));
    const token = match[0];
    if (token.startsWith("**")) {
      runs.push(makeRun({ text: token.slice(2, -2), bold: true }));
    } else if (token.startsWith("`")) {
      runs.push(makeRun({ text: token.slice(1, -1), font: "Consolas" }));
    } else {
      runs.push(makeRun({ text: token.slice(1, -1), italics: true }));
    }
    last = start + token.length;
  }
  if (last < text.length) runs.push(makeRun({ text: text.slice(last) }));
  return runs.length ? runs : [makeRun({ text })];
}

const BORDA = { style: BorderStyle.SINGLE, size: 4, color: "000000" } as const;

function buildTable(tableLines: string[]): Table {
  const parseRow = (line: string): string[] =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  const [headerLine, ...bodyLines] = tableLines;
  const makeRow = (cells: string[], header: boolean) =>
    new TableRow({
      children: cells.map(
        (cell) =>
          new TableCell({
            shading: header
              ? { type: ShadingType.CLEAR, fill: "E8E8E8" }
              : undefined,
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [
              new Paragraph({
                children: header
                  ? [makeRun({ text: cell.replace(/\*\*/g, ""), bold: true })]
                  : inlineRuns(cell),
              }),
            ],
          }),
      ),
    });

  const rows = [makeRow(parseRow(headerLine), true)];
  for (const line of bodyLines) {
    rows.push(makeRow(parseRow(line), false));
  }
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: BORDA,
      bottom: BORDA,
      left: BORDA,
      right: BORDA,
      insideHorizontal: BORDA,
      insideVertical: BORDA,
    },
    rows,
  });
}
