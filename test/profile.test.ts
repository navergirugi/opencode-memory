import { describe, expect, it } from "vitest"
import { readFile } from "node:fs/promises"
import {
  buildDeepAnalysisPrompt,
  profilePaths,
  renderProfileReport,
  writeDeepProfile,
} from "../src/profile.js"
import { tempDir } from "./helpers.js"
import type { Profile } from "../src/types.js"

function profile(scope: "global" | "project", statement: string): Profile {
  return {
    schema_version: 1,
    scope,
    developer_id: "alice",
    project_id: scope === "project" ? "proj" : undefined,
    analyzer_version: "1.1.0",
    generated_at: "2026-01-01T00:00:00.000Z",
    generated_from: { last_collected_at: "2026-01-01T00:00:00.000Z", last_record_ids: [] },
    stats: {
      records: 10,
      user_messages: 4,
      assistant_messages: 3,
      tool_calls: 3,
      sessions: 2,
      active_utc_hours: [9, 14],
    },
    tools: [{ name: "shell", count: 3 }],
    languages: [{ name: "TypeScript", count: 2 }],
    technical: [{ name: "TypeScript", category: "language", count: 2 }],
    preferences: [
      {
        id: "pref_1",
        statement,
        confidence: 0.8,
        evidence: [{ record_id: "r1", quote: "Always use pnpm for this repository." }],
        origin: "explicit",
      },
    ],
    workflow: { average_user_message_chars: 42, top_shell_commands: ["pnpm test", "git status"] },
  }
}

describe("profile", () => {
  it("renders global, project, explicit, and deep profile sections", () => {
    const report = renderProfileReport({
      developerID: "alice",
      developerName: "Alice",
      projectID: "proj",
      projectName: "Project",
      globalProfile: profile("global", "Always use pnpm."),
      projectProfile: profile("project", "Prefer small commits."),
      explicitPreferences: "- Prefer small, reviewable commits.",
      deepProfile: "## Communication style\n- Short questions.",
    })
    expect(report).toContain("OpenCode Memory developer profile")
    expect(report).toContain("### Global profile")
    expect(report).toContain("### Project profile")
    expect(report).toContain("Always use pnpm.")
    expect(report).toContain("Prefer small commits.")
    expect(report).toContain("Prefer small, reviewable commits.")
    expect(report).toContain("## Communication style")
    expect(report).toContain("capped by context_max_chars")
  })

  it("explains when no analysis exists yet", () => {
    const report = renderProfileReport({
      developerID: "alice",
      globalProfile: null,
      projectProfile: null,
      explicitPreferences: "",
      deepProfile: "",
    })
    expect(report).toContain("No analyzed profile yet")
    expect(report).toContain("(none)")
  })

  it("builds a bounded deep-analysis prompt with optional messages", () => {
    const prompt = buildDeepAnalysisPrompt({
      developerID: "alice",
      projectID: "proj",
      projectName: "Project",
      explicitPreferences: "- Prefer complete code.",
      globalProfile: profile("global", "Always use pnpm."),
      projectProfile: profile("project", "Prefer small commits."),
      userMessages: ["Why is this slow?", "Show me the fixed version."],
    })
    expect(prompt).toContain("Do not invent facts")
    expect(prompt).toContain("Instructions for AI assistants")
    expect(prompt).toContain("Prefer complete code.")
    expect(prompt).toContain("Global profile")
    expect(prompt).toContain("Project profile")
    expect(prompt).toContain("Recent user messages")
    expect(prompt).toContain("Why is this slow?")

    const withoutMessages = buildDeepAnalysisPrompt({
      developerID: "alice",
      explicitPreferences: "",
      globalProfile: profile("global", "Always use pnpm."),
      projectProfile: null,
    })
    expect(withoutMessages).not.toContain("Recent user messages")
    expect(withoutMessages).toContain("(none)")
  })

  it("writes the deep profile with a generated marker", async () => {
    const repo = await tempDir("deep-profile")
    const path = await writeDeepProfile(repo, "alice", "# Deep profile\n- Short answers.", "2026-01-01T00:00:00.000Z")
    expect(path).toBe(profilePaths(repo, "alice").deep)
    const text = await readFile(path, "utf8")
    expect(text).toContain("opencode-memory:deep-profile:v1")
    expect(text).toContain("2026-01-01T00:00:00.000Z")
    expect(text).toContain("# Deep profile")
  })
})
