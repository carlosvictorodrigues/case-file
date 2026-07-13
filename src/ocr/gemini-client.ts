/**
 * Versão do prompt de transcrição embutido no GoogleGeminiOcrClient.
 * v1 = envelope JSON (quebrava em página densa e pulava fotos);
 * v2 = texto puro pedindo TODO o texto "jurídico" visível;
 * v3 = sem o filtro "jurídico" + inclui explicitamente documentos
 *      fotografados, formulários, tabelas e manuscritos (achado de campo
 *      caso-2: com v2 o modelo transcrevia só os carimbos digitais e
 *      pulava a foto — 37/183 páginas).
 * Páginas OCRizadas com prompt < atual e rendimento só-carimbo são
 * re-enfileiradas na retomada (uma única vez por versão).
 */
export const OCR_PROMPT_VERSION = 3;

export interface GeminiTranscription {
  text: string;
  reading_confidence: number;
  bbox?: [number, number, number, number];
  /** Tokens reais informados pela API (entrada; saída inclui thinking). */
  tokens?: { entrada: number; saida: number };
}

export interface GeminiOcrClient {
  transcribePage(input: {
    imageBytes: Uint8Array;
    mimeType: "image/png" | "application/pdf";
    apiKey: string;
    model: string;
  }): Promise<GeminiTranscription>;
}

export class GoogleGeminiOcrClient implements GeminiOcrClient {
  async transcribePage(input: {
    imageBytes: Uint8Array;
    mimeType: "image/png" | "application/pdf";
    apiKey: string;
    model: string;
  }): Promise<GeminiTranscription> {
    const base64 = Buffer.from(input.imageBytes).toString("base64");
    // Chave SEMPRE no header, nunca na URL: URLs vazam em logs de
    // proxy/undici e em mensagens de erro que acabam persistidas.
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": input.apiKey,
        },
        body: JSON.stringify({
          // Raciocínio interno DESLIGADO: transcrição não precisa "pensar" e
          // o thinking era ~70% do custo por página (medição de campo na
          // fatura real: R$0,198/pág com thinking vs ~R$0,05 sem).
          generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
          contents: [
            {
              parts: [
                {
                  // Texto PURO, sem envelope JSON: transcrições longas quebravam
                  // o JSON de resposta de forma determinística (bug de campo
                  // caso-2, páginas densas). Transcrição é texto; peça texto.
                  // Sem a palavra "jurídico": com ela o modelo pulava o conteúdo
                  // FOTOGRAFADO (formulário trabalhista) e devolvia só carimbos.
                  text: "Transcreva fielmente TODO o texto visivel nesta pagina, inclusive de documentos fotografados ou escaneados, formularios, tabelas, carimbos e trechos manuscritos legiveis. Responda APENAS com o texto transcrito, sem comentarios, sem formatacao adicional. Se realmente nao houver texto legivel, responda com uma linha vazia.",
                },
                { inline_data: { mime_type: input.mimeType, data: base64 } },
              ],
            },
          ],
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Gemini OCR failed with HTTP ${response.status}`);
    }
    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      };
    };
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    // Tokens REAIS da resposta (achado de campo: descartá-los obrigava o
    // usuário a descobrir o gasto na fatura do Google).
    const usage = json.usageMetadata;
    return {
      // Sem envelope JSON não há autoavaliação de confiança do modelo; o
      // valor fixo conservador sinaliza "transcrição de OCR, conferir".
      text,
      reading_confidence: 0.6,
      tokens: usage
        ? {
            entrada: usage.promptTokenCount ?? 0,
            saida: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
          }
        : undefined,
    };
  }
}
