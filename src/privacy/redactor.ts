const DEFAULT_SENSITIVE_KEYS = [
  "token",
  "api_key",
  "secret",
  "password",
  "authorization",
  "cookie",
  "session",
  "private_key",
];

const REDACTED = "[redacted]";

const DEFAULT_VALUE_PATTERNS = [
  /(^|\s)bearer\s+[a-z0-9\-_.=:+/]+/i,
  /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^sk-[a-z0-9\-_]+$/i,
  /^(?:[A-Za-z0-9+/]{40,}={0,2})$/,
];

// Secrets embedded in free text, such as a shell command.
const INLINE_VALUE_PATTERNS = [
  /\bbearer\s+[A-Za-z0-9\-_.=:+/]+/gi,
  /\bsk-[A-Za-z0-9\-_]{8,}/g,
  /\b[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}\b/g,
  /[A-Za-z0-9+/]{40,}={0,2}/g,
];

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface RedactorOptions {
  extraSensitiveKeys: string[];
  pathDenylist: string[];
}

export interface Redactor {
  redact(value: unknown): unknown;
  /** Masks secrets inside free text: token-like substrings and NAME=value pairs with a sensitive name. */
  redactText(text: string): string;
  shouldSkipPath(path: string): boolean;
}

export function createRedactor(options: RedactorOptions): Redactor {
  const keyPatterns = DEFAULT_SENSITIVE_KEYS.concat(options.extraSensitiveKeys)
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key) => new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));

  const denyPatterns = options.pathDenylist.map((pattern) => wildcardToRegExp(pattern));

  const matchesSensitiveKey = (key: string) => keyPatterns.some((pattern) => pattern.test(key));

  const matchesSensitiveValue = (value: string) => DEFAULT_VALUE_PATTERNS.some((pattern) => pattern.test(value));

  const redactRecursive = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((entry) => redactRecursive(entry));
    }

    if (isPlainObject(value)) {
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (matchesSensitiveKey(key)) {
          output[key] = REDACTED;
          continue;
        }
        output[key] = redactRecursive(entry);
      }
      return output;
    }

    if (typeof value === "string" && matchesSensitiveValue(value.trim())) {
      return REDACTED;
    }

    return value;
  };

  return {
    redact(value: unknown): unknown {
      return redactRecursive(value);
    },
    redactText(text: string): string {
      const assigned = text.replace(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, (match, name: string) =>
        matchesSensitiveKey(name) ? `${name}=${REDACTED}` : match,
      );
      return INLINE_VALUE_PATTERNS.reduce((current, pattern) => current.replace(pattern, REDACTED), assigned);
    },
    shouldSkipPath(path: string): boolean {
      return denyPatterns.some((pattern) => pattern.test(path));
    },
  };
}
