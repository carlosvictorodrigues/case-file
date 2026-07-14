import { z } from "zod";
import type { CaseFileConfig } from "./config.js";
import {
  analyzeCivilCase,
  analyzeCivilRadar,
  authorizeOcr,
  removerCaso,
  buildEvidenceBundle,
  consultarLinhaDoTempo,
  consultarMapaCaderno,
  getCaseFile,
  getStatus,
  indexSemantics,
  listCases,
  mapearControversias,
  openEvidence,
  openPage,
  resumeIngestJob,
  searchCaseHybrid,
} from "./core/case-service.js";
import { lerDossie, registrarAchado } from "./core/dossie.js";
import { exportarDocumento } from "./core/export-docx.js";
import { openOnComputer, type LocalOpener } from "./core/open-local.js";
import type { EmbeddingClient } from "./embeddings/gemini-embedding-client.js";
import { consultarPrazos } from "./civil/prazos.js";
import { registerJurisprudence } from "./core/jurisprudence.js";
import { verifyReferences } from "./core/verifier.js";
import { createCaseJob, type IngestStartMode } from "./ingest/worker.js";
import { startIngestJobInBackground, type OcrRuntimeOptions } from "./jobs/worker-runner.js";

export function ocrOptions(config: CaseFileConfig): OcrRuntimeOptions {
  return {
    model: config.ocrModel,
    maxRetryAttempts: config.ocrMaxRetryAttempts,
    approvalPageThreshold: config.ocrApprovalPageThreshold,
    maxConcurrency: config.ocrMaxConcurrency,
  };
}
export interface ToolDependencies {
  workerStartMode?: IngestStartMode;
  /** Injetável em teste; produção usa o cliente Gemini real. */
  embedClient?: EmbeddingClient;
  /** Injetável em teste; produção abre no visualizador/Explorer do SO. */
  opener?: LocalOpener;
}

const createCaseSchema = z.object({
  pdf_path: z.string(),
  area: z.literal("civil").default("civil"),
  slug: z.string().optional(),
});
const caseIdSchema = z.object({ case_id: z.string() });
const removerCasoSchema = z.object({
  case_id: z.string().min(1),
  confirmar: z.string().min(1),
});
const searchSchema = z.object({
  case_id: z.string(),
  query: z.string(),
  limit: z.number().int().min(1).max(50).default(10),
});
// Fusão abrir_trecho+abrir_pagina (P13, unânime): mesmo job — "ler o
// original completo" — por evidence_id OU por página (exatamente um).
const lerOriginalSchema = z
  .object({
    case_id: z.string(),
    evidence_id: z.string().optional(),
    pagina: z.number().int().min(1).optional(),
  })
  .refine((args) => (args.evidence_id ? !args.pagina : !!args.pagina), {
    message: "Informe exatamente um: evidence_id OU pagina.",
  });
const bundleSchema = z.object({
  case_id: z.string(),
  objetivo: z.string(),
  lado: z.string(),
  max_items: z.number().int().min(1).max(50).default(30),
  dados_pessoais_adicionais: z.array(z.string()).optional(),
});
const consultarPrazosSchema = z.object({
  ato: z.string().optional(),
});
const mapaCadernoSchema = z.object({
  case_id: z.string(),
  tipo: z.string().optional(),
  modo: z.enum(["principais", "completo"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
  min_paginas: z.number().int().min(1).optional(),
});
const anotarAchadoSchema = z.object({
  case_id: z.string(),
  achado: z.string().min(1),
  evidence_ids: z.array(z.string().min(1)).min(1),
});
const linhaDoTempoSchema = z.object({
  case_id: z.string(),
  de: z.string().optional(),
  ate: z.string().optional(),
});
const abrirNoComputadorSchema = z.object({
  case_id: z.string(),
  page: z.number().int().min(1).optional(),
  alvo: z.enum(["pagina", "processo"]).default("pagina"),
  revelar: z.boolean().default(false),
});
const mapearControversiasSchema = z.object({
  case_id: z.string(),
  temas: z
    .array(
      z.object({
        nome: z.string().min(1),
        queries: z.array(z.string().min(1)).optional(),
      }),
    )
    .min(1)
    .max(10),
  limit_por_tema: z.number().int().min(1).max(10).default(4),
  incluir_fontes_primarias: z.boolean().default(true),
});
const exportarDocumentoSchema = z.object({
  case_id: z.string(),
  titulo: z.string().min(1),
  conteudo_markdown: z.string().min(1),
  abrir: z.boolean().default(true),
});
const indexarSemanticaSchema = z.object({
  case_id: z.string(),
  max_calls: z.number().int().min(1).max(2000),
});
const authorizeOcrSchema = z.object({
  case_id: z.string(),
  max_pages: z.number().int().min(1),
  max_calls: z.number().int().min(1),
});
const radarSchema = z.object({
  case_id: z.string(),
  lado: z.enum(["autor", "reu"]).default("autor"),
});
const analyzeCivilCaseSchema = z.object({
  case_id: z.string(),
  objetivo: z.string(),
  lado: z.enum(["autor", "reu"]).default("autor"),
  max_items: z.number().int().min(1).max(50).default(30),
});
// Sem jurisprudence_doc_ids: o chamador não auto-atesta doc_ids — a única
// fonte aceita é o registro local gravado por registrar_jurisprudencia.
const claimSchema = z.object({
  claim_id: z.string().optional(),
  afirmacao: z.string().min(1),
  supports: z
    .array(
      z.object({
        evidence_id: z.string().min(1),
        trecho_base: z.string().min(1),
      }),
    )
    .min(1),
  doc_ids: z.array(z.string()).optional(),
});
const verifySchema = z.object({
  case_id: z.string(),
  evidence_ids: z.array(z.string()).default([]),
  doc_ids: z.array(z.string()).default([]),
  claims: z.array(claimSchema).optional(),
});
const registrarJurisprudenciaSchema = z.object({
  case_id: z.string(),
  documentos: z
    .array(
      z.object({
        doc_id: z.string().min(1),
        titulo: z.string().optional(),
        tribunal: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .min(1),
});

export function makeTools(config: CaseFileConfig, deps: ToolDependencies = {}) {
  return {
    async criar_caso_local(input: unknown) {
      const args = createCaseSchema.parse(input);
      return createCaseJob(config.casesDir, args.pdf_path, args.slug, {
        startMode: deps.workerStartMode ?? "background",
        geminiApiKey: config.geminiApiKey,
        ocr: ocrOptions(config),
      });
    },

    async status_caso(input: unknown) {
      const args = caseIdSchema.parse(input);
      return getStatus(config.casesDir, args.case_id);
    },

    async listar_casos() {
      return listCases(config.casesDir);
    },

    async case_file(input: unknown) {
      const args = caseIdSchema.parse(input);
      return getCaseFile(config.casesDir, args.case_id);
    },

    async mapa_do_caderno(input: unknown) {
      const args = mapaCadernoSchema.parse(input);
      return consultarMapaCaderno(config.casesDir, args.case_id, {
        tipo: args.tipo,
        modo: args.modo,
        limit: args.limit,
        offset: args.offset,
        min_paginas: args.min_paginas,
      });
    },

    async linha_do_tempo(input: unknown) {
      const args = linhaDoTempoSchema.parse(input);
      return consultarLinhaDoTempo(config.casesDir, args.case_id, {
        de: args.de,
        ate: args.ate,
      });
    },

    async anotar_achado(input: unknown) {
      const args = anotarAchadoSchema.parse(input);
      return registrarAchado(config.casesDir, args.case_id, args.achado, args.evidence_ids);
    },

    async dossie(input: unknown) {
      const args = caseIdSchema.parse(input);
      return lerDossie(config.casesDir, args.case_id);
    },

    async buscar_no_processo(input: unknown) {
      const args = searchSchema.parse(input);
      const { results, busca } = await searchCaseHybrid(
        config.casesDir,
        args.case_id,
        args.query,
        args.limit,
        {
          geminiApiKey: config.geminiApiKey,
          model: config.embeddingModel,
          client: deps.embedClient,
        },
      );
      return { results, busca };
    },

    async indexar_semantica(input: unknown) {
      const args = indexarSemanticaSchema.parse(input);
      return indexSemantics(config.casesDir, args.case_id, {
        maxCalls: args.max_calls,
        geminiApiKey: config.geminiApiKey,
        model: config.embeddingModel,
        client: deps.embedClient,
      });
    },

    async ler_original(input: unknown) {
      const args = lerOriginalSchema.parse(input);
      return args.evidence_id
        ? openEvidence(config.casesDir, args.case_id, args.evidence_id)
        : openPage(config.casesDir, args.case_id, args.pagina as number);
    },

    async exportar_documento(input: unknown) {
      const args = exportarDocumentoSchema.parse(input);
      return exportarDocumento(config.casesDir, args.case_id, args.titulo, args.conteudo_markdown, {
        abrir: args.abrir,
        opener: deps.opener,
      });
    },

    async abrir_no_computador(input: unknown) {
      const args = abrirNoComputadorSchema.parse(input);
      return openOnComputer(
        config.casesDir,
        args.case_id,
        { page: args.page, alvo: args.alvo, revelar: args.revelar },
        deps.opener,
      );
    },

    async mapear_controversias(input: unknown) {
      const args = mapearControversiasSchema.parse(input);
      return mapearControversias(config.casesDir, args.case_id, args.temas, {
        geminiApiKey: config.geminiApiKey,
        model: config.embeddingModel,
        client: deps.embedClient,
        limitPorTema: args.limit_por_tema,
        incluirFontesPrimarias: args.incluir_fontes_primarias,
      });
    },

    async montar_pacote_evidencias(input: unknown) {
      const args = bundleSchema.parse(input);
      return buildEvidenceBundle(
        config.casesDir,
        args.case_id,
        args.objetivo,
        args.lado,
        args.max_items,
        {
          geminiApiKey: config.geminiApiKey,
          model: config.embeddingModel,
          client: deps.embedClient,
          dadosPessoaisAdicionais: args.dados_pessoais_adicionais,
        },
      );
    },

    async remover_caso(input: unknown) {
      const args = removerCasoSchema.parse(input);
      return removerCaso(config.casesDir, args.case_id, args.confirmar);
    },

    async retomar_ingestao(input: unknown) {
      const args = caseIdSchema.parse(input);
      // Valida que o caso existe ANTES de agendar (o background engole erros).
      const statusAtual = getStatus(config.casesDir, args.case_id);
      // Worker comprovadamente VIVO: retomar agora só disputaria o lease
      // (a causa raiz do "owner mismatch" de campo). Recusa com orientação.
      if (
        (statusAtual.status === "running" || statusAtual.status === "queued") &&
        statusAtual.execucao &&
        !statusAtual.execucao.includes("INATIVO")
      ) {
        return {
          case_id: args.case_id,
          status: "retomada_nao_agendada",
          message: `Já há um worker ativo neste caso (${statusAtual.execucao}). Aguarde e consulte status_caso; retomar agora causaria disputa. Retome apenas se o status indicar worker INATIVO ou erro.`,
        };
      }
      // Em background: um processo grande estourava o timeout do cliente MCP
      // com a retomada síncrona (achado de campo do caso-2/TJCE).
      startIngestJobInBackground({
        root: config.casesDir,
        caseId: args.case_id,
        geminiApiKey: config.geminiApiKey,
        ocr: ocrOptions(config),
      });
      return {
        case_id: args.case_id,
        status: "retomada_iniciada_em_background",
        message: "Ingestao retomada em background; acompanhe com status_caso.",
      };
    },

    async autorizar_ocr(input: unknown) {
      const args = authorizeOcrSchema.parse(input);
      return authorizeOcr(config.casesDir, args.case_id, {
        max_pages: args.max_pages,
        max_calls: args.max_calls,
      });
    },

    async analisar_radar_processual_civel(input: unknown) {
      const args = radarSchema.parse(input);
      return analyzeCivilRadar(config.casesDir, args.case_id, args.lado);
    },

    async analisar_caso_civel(input: unknown) {
      const args = analyzeCivilCaseSchema.parse(input);
      return analyzeCivilCase(
        config.casesDir,
        args.case_id,
        args.objetivo,
        args.lado,
        args.max_items,
        {
          geminiApiKey: config.geminiApiKey,
          model: config.embeddingModel,
          client: deps.embedClient,
        },
      );
    },

    async consultar_prazos_referencia(input: unknown) {
      const args = consultarPrazosSchema.parse(input);
      return consultarPrazos(args.ato);
    },

    async registrar_jurisprudencia(input: unknown) {
      const args = registrarJurisprudenciaSchema.parse(input);
      return registerJurisprudence(config.casesDir, args.case_id, args.documentos);
    },

    async verificar_referencias(input: unknown) {
      const args = verifySchema.parse(input);
      return verifyReferences(config.casesDir, args.case_id, args);
    },
  };
}
