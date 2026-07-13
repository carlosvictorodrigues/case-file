export interface EmbeddingContentInput {
  /** Texto já formatado (com prefixo de task quando for retrieval). */
  text?: string;
  /** PDF de UMA página (limite documentado: 1 arquivo por request). */
  pdfBytes?: Uint8Array;
}

export interface EmbeddingClient {
  embedContents(input: {
    items: EmbeddingContentInput[];
    apiKey: string;
    model: string;
  }): Promise<number[][]>;
}

const OUTPUT_DIMENSIONALITY = 768;

export class GoogleGeminiEmbeddingClient implements EmbeddingClient {
  async embedContents(input: {
    items: EmbeddingContentInput[];
    apiKey: string;
    model: string;
  }): Promise<number[][]> {
    // batchEmbedContents com um request por item devolve um embedding POR
    // request (é o shape documentado do gemini-embedding-2 para múltiplos
    // embeddings; múltiplas parts num mesmo content seriam AGREGADAS em um
    // vetor só). Chave SEMPRE no header, nunca na URL.
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:batchEmbedContents`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": input.apiKey,
        },
        body: JSON.stringify({
          requests: input.items.map((item) => ({
            model: `models/${input.model}`,
            content: {
              parts:
                item.text !== undefined
                  ? [{ text: item.text }]
                  : [
                      {
                        inline_data: {
                          mime_type: "application/pdf",
                          data: Buffer.from(item.pdfBytes ?? new Uint8Array()).toString("base64"),
                        },
                      },
                    ],
            },
            outputDimensionality: OUTPUT_DIMENSIONALITY,
          })),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Gemini embeddings failed with HTTP ${response.status}`);
    }
    const json = (await response.json()) as {
      embeddings?: Array<{ values?: number[] }>;
    };
    const embeddings = json.embeddings ?? [];
    if (embeddings.length !== input.items.length) {
      throw new Error(
        `Gemini embeddings returned ${embeddings.length} vectors for ${input.items.length} inputs`,
      );
    }
    return embeddings.map((embedding) => embedding.values ?? []);
  }
}
