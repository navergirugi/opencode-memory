/**
 * Best-effort redaction for collected conversation data.
 * This is a safety net, not a guarantee. Records never include configuration
 * tokens, but prompts and tool output can contain user secrets.
 */

const REDACTED = "[REDACTED]"

type Rule = { name: string; pattern: RegExp; replace?: (match: string, ...groups: string[]) => string }

const RULES: Rule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  },
  {
    name: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    name: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    name: "openai-key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    name: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    name: "bearer",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: () => `Bearer ${REDACTED}`,
  },
  {
    name: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    replace: (_match, scheme) => `${scheme}${REDACTED}@`,
  },
  {
    name: "assignment",
    pattern:
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|pwd|secret|token|authorization)\b\s*[:=]\s*(["']?)([^\s"',;]{6,})\2/gi,
    replace: (_match, key, quote) => `${key}=${quote}${REDACTED}${quote}`,
  },
  {
    name: "env-secret",
    pattern: /^([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(.+)$/gm,
    replace: (_match, key) => `${key}=${REDACTED}`,
  },
  {
    name: "home-directory",
    pattern: /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+)/g,
    replace: () => "~",
  },
]

const SENSITIVE_NAME_RE =
  /(^\.env($|\.)|(^|\.)env$|id_(?:rsa|dsa|ecdsa|ed25519)|\.pem$|\.key$|\.p12$|\.pfx$|credentials(?:\.json)?$|secrets?(?:\.json|\.ya?ml)$|\.npmrc$|\.netrc$)/i

export function isSensitiveFilename(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name
  if (/^\.env\.(example|sample|template)$/i.test(base)) return false
  return SENSITIVE_NAME_RE.test(base)
}

export function redactText(input: string, maxChars = 8_000): string {
  let text = input
  for (const rule of RULES) {
    text = rule.replace
      ? text.replace(rule.pattern, rule.replace as (substring: string, ...args: any[]) => string)
      : text.replace(rule.pattern, REDACTED)
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`
  }
  return text
}

const SENSITIVE_KEY_RE = /(token|secret|password|passwd|credential|api[_-]?key|authorization|private[_-]?key)/i

/** Redact a JSON-like value from tool input/output before persisting it. */
export function redactJson(value: unknown, depth = 0, maxString = 2_000): unknown {
  if (depth > 6) return "[depth-limit]"
  if (value === null || value === undefined) return value
  if (typeof value === "string") return redactText(value, maxString)
  if (typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactJson(entry, depth + 1, maxString))
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    let count = 0
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (count++ >= 100) break
      out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : redactJson(entry, depth + 1, maxString)
    }
    return out
  }
  return String(value)
}

export function redactUrl(url: string): string {
  return url.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, (_m, scheme) => `${scheme}${REDACTED}@`)
}
