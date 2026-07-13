import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

describe("MCPB manifest", () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "manifest.json"), "utf8"));

  it("declares a node MCPB server and local-only config", () => {
    expect(manifest.manifest_version).toBe("0.4");
    expect(manifest.name).toBe("case-file");
    expect(manifest.display_name).toBe("Case File");
    expect(manifest.server.type).toBe("node");
    expect(manifest.server.entry_point).toBe("dist/server.js");
    expect(manifest.server.mcp_config.env.CASE_FILE_CASES_DIR).toBe("${user_config.cases_dir}");
    expect(manifest.server.mcp_config.env.JUSRATIO_CASES_DIR).toBeUndefined();
    expect(manifest.user_config.gemini_api_key.sensitive).toBe(true);
    // Opcional de propósito: sem chave o Case File degrada bem (PDF nativo
    // funciona, escaneado fica pendente) e o onboarding do advogado não trava.
    expect(manifest.user_config.gemini_api_key.required).toBe(false);
    expect(manifest.user_config.gemini_ocr_model.default).toBe("gemini-3.5-flash");
    expect(manifest.user_config.ocr_max_concurrency.required).toBe(false);
    expect(manifest.user_config.cases_dir.type).toBe("directory");
  });

  it("points support and repository at the public repo", () => {
    expect(manifest.repository.url).toBe("https://github.com/carlosvictorodrigues/case-file");
    expect(manifest.support).toBe("https://github.com/carlosvictorodrigues/case-file/issues");
  });

  it("declares the local tool surface", () => {
    const names = manifest.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("criar_caso_local");
    expect(names).toContain("buscar_no_processo");
    expect(names).toContain("montar_pacote_evidencias");
    expect(names).toContain("retomar_ingestao");
    expect(names).toContain("autorizar_ocr");
    expect(names).toContain("analisar_radar_processual_civel");
    expect(names).toContain("analisar_caso_civel");
    expect(names).toContain("registrar_jurisprudencia");
    expect(names).toContain("consultar_prazos_referencia");
    expect(names).toContain("verificar_referencias");
    expect(names).not.toContain("pesquisar_jurisprudencia_para_caso");
  });
});

describe("loadConfig", () => {
  it("parses required and optional env vars", () => {
    const cfg = loadConfig({
      CASE_FILE_CASES_DIR: "/tmp/CaseFileCases",
      GEMINI_API_KEY: "gemini-secret",
    });
    expect(cfg.casesDir).toBe("/tmp/CaseFileCases");
    expect(cfg.geminiApiKey).toBe("gemini-secret");
    expect(cfg.ocrModel).toBe("gemini-3.5-flash");
    expect(cfg.ocrMaxConcurrency).toBe(2);
  });

  it("aceita os nomes legados de env var (instalação antiga não quebra)", () => {
    const cfg = loadConfig({
      JUSRATIO_CASES_DIR: "/tmp/LegacyCases",
      JUSRATIO_OCR_MAX_CONCURRENCY: "4",
    });
    expect(cfg.casesDir).toBe("/tmp/LegacyCases");
    expect(cfg.ocrMaxConcurrency).toBe(4);
  });

  it("o nome novo vence o legado quando ambos existem", () => {
    const cfg = loadConfig({
      CASE_FILE_CASES_DIR: "/tmp/Novo",
      JUSRATIO_CASES_DIR: "/tmp/Velho",
    });
    expect(cfg.casesDir).toBe("/tmp/Novo");
  });

  it("falls back to safe defaults on invalid numeric env values", () => {
    const cfg = loadConfig({
      CASE_FILE_CASES_DIR: "/tmp/CaseFileCases",
      CASE_FILE_OCR_APPROVAL_PAGE_THRESHOLD: "abc",
      CASE_FILE_OCR_MAX_RETRY_ATTEMPTS: "-5",
    });
    expect(cfg.ocrApprovalPageThreshold).toBe(25);
    expect(cfg.ocrMaxRetryAttempts).toBe(3);
  });

  it("fails without CASE_FILE_CASES_DIR", () => {
    expect(() => loadConfig({})).toThrow("CASE_FILE_CASES_DIR is required");
  });
});
