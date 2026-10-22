import { describe, expect, it } from "vitest"
import { isSensitiveFilename, redactJson, redactText, redactUrl } from "../src/redact.js"

describe("redaction", () => {
  it("masks common credentials", () => {
    const input = [
      "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "url=https://user:pass@example.com/repo",
      "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----",
    ].join("\n")
    const output = redactText(input)
    expect(output).not.toContain("ghp_")
    expect(output).not.toContain("sk-abcdef")
    expect(output).not.toContain("user:pass")
    expect(output).not.toContain("secret\n")
    expect(output).toContain("[REDACTED]")
  })

  it("masks secret environment assignments and home directories", () => {
    const output = redactText("GITHUB_TOKEN=abc123456789\npath=/Users/alice/project")
    expect(output).toBe("GITHUB_TOKEN=[REDACTED]\npath=~/project")
  })

  it("redacts sensitive object keys recursively", () => {
    const output = redactJson({ token: "abc", nested: { password: "p", safe: "ok" }, list: [{ apiKey: "x" }] })
    expect(output).toEqual({ token: "[REDACTED]", nested: { password: "[REDACTED]", safe: "ok" }, list: [{ apiKey: "[REDACTED]" }] })
  })

  it("flags sensitive file names", () => {
    expect(isSensitiveFilename(".env")).toBe(true)
    expect(isSensitiveFilename(".env.local")).toBe(true)
    expect(isSensitiveFilename("id_ed25519")).toBe(true)
    expect(isSensitiveFilename("credentials.json")).toBe(true)
    expect(isSensitiveFilename(".env.example")).toBe(false)
    expect(isSensitiveFilename("src/index.ts")).toBe(false)
  })

  it("redacts URL credentials without hiding the host", () => {
    expect(redactUrl("https://x:y@github.com/org/repo.git")).toBe("https://[REDACTED]@github.com/org/repo.git")
  })
})
