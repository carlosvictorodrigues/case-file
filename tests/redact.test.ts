import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/security/redact.js";

describe("redactSecrets", () => {
  it("redacts Google API key patterns", () => {
    const msg = "fetch failed for key AIzaSyD4mmyK3y1234567890abcdefghijk";
    expect(redactSecrets(msg)).not.toContain("AIzaSy");
    expect(redactSecrets(msg)).toContain("[REDACTED]");
  });

  it("redacts key= query params embedded in URLs", () => {
    const msg = "HTTP 400 at https://example.com/v1?key=super-secret-value&x=1";
    const out = redactSecrets(msg);
    expect(out).not.toContain("super-secret-value");
    expect(out).toContain("key=[REDACTED]");
  });

  it("redacts known secrets passed explicitly", () => {
    const out = redactSecrets("boom: minha-chave-byok-123 vazou", ["minha-chave-byok-123"]);
    expect(out).toBe("boom: [REDACTED] vazou");
  });
});
