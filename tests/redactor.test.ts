import { describe, expect, it } from "vitest";
import { createRedactor } from "../src/privacy/redactor.js";

describe("redactor", () => {
  it("masks sensitive keys recursively", () => {
    const redactor = createRedactor({
      extraSensitiveKeys: [],
      pathDenylist: [],
    });

    const input = {
      token: "secret-token",
      nested: {
        password: "pw",
        api_key: "secret-api-key",
        ok: "safe",
      },
    };

    expect(redactor.redact(input)).toEqual({
      token: "[redacted]",
      nested: {
        password: "[redacted]",
        api_key: "[redacted]",
        ok: "safe",
      },
    });
  });

  it("masks sensitive value patterns", () => {
    const redactor = createRedactor({ extraSensitiveKeys: [], pathDenylist: [] });

    const input = {
      header: "Bearer abcd",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
      pem: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      openai: "sk-test-12345",
    };

    expect(redactor.redact(input)).toEqual({
      header: "[redacted]",
      jwt: "[redacted]",
      pem: "[redacted]",
      openai: "[redacted]",
    });
  });

  it("extends sensitive key list", () => {
    const redactor = createRedactor({
      extraSensitiveKeys: ["refreshToken"],
      pathDenylist: [],
    });

    expect(redactor.redact({ refreshToken: "abc" })).toEqual({
      refreshToken: "[redacted]",
    });
  });

  it("matches denylist path patterns", () => {
    const redactor = createRedactor({
      extraSensitiveKeys: [],
      pathDenylist: [".env", "*.pem", "secrets/*"],
    });

    expect(redactor.shouldSkipPath(".env")).toBe(true);
    expect(redactor.shouldSkipPath("/repo/config/.env")).toBe(true);
    expect(redactor.shouldSkipPath("C:\\repo\\.env")).toBe(true);
    expect(redactor.shouldSkipPath("tls/key.pem")).toBe(true);
    expect(redactor.shouldSkipPath("secrets/prod/token.txt")).toBe(true);
    expect(redactor.shouldSkipPath("src/index.ts")).toBe(false);
  });

  it("applies free-text rules inside nested payload strings", () => {
    const redactor = createRedactor({ extraSensitiveKeys: [], pathDenylist: [] });
    const result = JSON.stringify(redactor.redact({ content: [{ text:
      "log\nAuthorization: Basic dXNlcjpjYW5hcnk=\n-----BEGIN PRIVATE KEY-----\nshort-secret\n-----END PRIVATE KEY-----\nend",
    }] }));
    expect(result).not.toContain("dXNlcjpjYW5hcnk=");
    expect(result).not.toContain("short-secret");
    expect(result).toContain("[redacted]");
  });

  it("masks secrets inside free text", () => {
    const redactor = createRedactor({ extraSensitiveKeys: ["github_pat"], pathDenylist: [] });
    const text = redactor.redactText("GITHUB_PAT=x1 PASSWORD='p w' MODE=fast git push https://x Bearer abc.def");
    expect(text).toBe("GITHUB_PAT=[redacted] PASSWORD=[redacted] MODE=fast git push https://x [redacted]");
  });
});
