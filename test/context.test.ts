import { describe, expect, it } from "vitest"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { buildContextText } from "../src/context.js"
import { tempDir } from "./helpers.js"
import type { Profile } from "../src/types.js"

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    schema_version: 1,
    scope: "project",
    developer_id: "alice",
    project_id: "proj",
    analyzer_version: "1.0.0",
    generated_at: "2026-01-01T00:00:00.000Z",
    generated_from: { last_collected_at: "2026-01-01T00:00:00.000Z", last_record_ids: [] },
    stats: { records: 1, user_messages: 1, assistant_messages: 0, tool_calls: 0, sessions: 1, active_utc_hours: [1] },
    tools: [{ name: "shell", count: 4 }],
    languages: [{ name: "TypeScript", count: 4 }],
    technical: [{ name: "TypeScript", category: "language", count: 5 }],
    preferences: [{ id: "pref-1", statement: "Prefer small commits", confidence: 0.8, evidence: [], origin: "explicit" }],
    workflow: { average_user_message_chars: 20, top_shell_commands: ["pnpm test"] },
    ...overrides,
  }
}

describe("context builder", () => {
  it("prioritizes project rules and deduplicates lines", async () => {
    const repo = await tempDir("context")
    await mkdir(join(repo, "projects", "proj", "developers", "alice"), { recursive: true })
    await mkdir(join(repo, "developers", "alice"), { recursive: true })
    await writeFile(join(repo, "projects", "proj", "conventions.md"), "# Rules\n- Always run tests\n", "utf8")
    await writeFile(join(repo, "projects", "proj", "shared-context.md"), "# Shared\nAlways run tests\nUse pnpm\n", "utf8")
    await writeFile(join(repo, "projects", "proj", "developers", "alice", "profile.json"), JSON.stringify(profile()), "utf8")
    await writeFile(join(repo, "developers", "alice", "profile.json"), JSON.stringify(profile({ scope: "global", preferences: [{ id: "g", statement: "Prefer concise answers", confidence: 0.8, evidence: [], origin: "explicit" }] })), "utf8")
    await writeFile(join(repo, "developers", "alice", "preferences.md"), "# Preferences\n- Prefer complete code\n", "utf8")
    await writeFile(join(repo, "developers", "alice", "deep-profile.md"), "<!-- marker -->\n# Deep profile\n- Short questions\n", "utf8")

    const text = await buildContextText({ repoDir: repo, developerID: "alice", projectID: "proj", maxChars: 2_000 })
    expect(text).toContain("Project conventions (authoritative)")
    expect(text).toContain("Project shared context")
    expect(text).toContain("Your project profile (inferred)")
    expect(text).toContain("Prefer small commits")
    expect(text).toContain("Prefer concise answers")
    expect(text).toContain("Your explicit preferences")
    expect(text).toContain("Prefer complete code")
    expect(text).toContain("Your deep developer profile")
    expect(text).toContain("Short questions")
    expect(text).not.toContain("marker")
    expect(text!.indexOf("Project conventions")).toBeLessThan(text!.indexOf("Your global preferences"))
    expect(text!.match(/Always run tests/g)?.length).toBe(1)
  })

  it("honors the character limit and never includes unapproved project data", async () => {
    const repo = await tempDir("context")
    await mkdir(join(repo, "projects", "other", "developers", "alice"), { recursive: true })
    await writeFile(join(repo, "projects", "other", "developers", "alice", "profile.json"), JSON.stringify(profile({ project_id: "other", preferences: [{ id: "o", statement: "Other project secret", confidence: 1, evidence: [], origin: "explicit" }] })), "utf8")
    const text = await buildContextText({ repoDir: repo, developerID: "alice", projectID: "proj", maxChars: 120 })
    expect(text).not.toContain("Other project secret")
    expect(text.length).toBeLessThanOrEqual(200)
  })

  it("returns nothing when context is disabled", async () => {
    const repo = await tempDir("context")
    expect(await buildContextText({ repoDir: repo, developerID: "alice", projectID: "proj", maxChars: 0 })).toBe("")
  })
})
