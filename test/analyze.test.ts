import { describe, expect, it } from "vitest"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  analysisDue,
  analyzeRecords,
  comparePosition,
  extractPreferences,
  mergePreferences,
  nextAnalysisAt,
  readCheckpoint,
  runAnalysis,
  shouldWriteProfile,
} from "../src/analyze.js"
import { RecordStore } from "../src/store.js"
import { noopLogger } from "../src/logger.js"
import { tempDir } from "./helpers.js"
import type { MemoryRecord } from "../src/types.js"

function rec(overrides: Partial<MemoryRecord>): MemoryRecord {
  const session = overrides.session_id ?? "ses_1"
  const message = overrides.message_id ?? `msg_${Math.random().toString(16).slice(2)}`
  return {
    schema_version: 1,
    record_id: `${session}:${message}:user`,
    kind: "message.user",
    project_id: "proj",
    developer_id: "alice",
    device_id: "dev_a",
    session_id: session,
    message_id: message,
    event: "message.user",
    created_at: "2026-01-01T00:00:00.000Z",
    collected_at: "2026-01-01T00:00:00.000Z",
    source: "api",
    payload: { text: "hello" },
    ...overrides,
  }
}

describe("analyzer", () => {
  it("extracts explicit and repeated preferences with evidence", () => {
    const records = [
      rec({ record_id: "r1", payload: { text: "Always use pnpm for this repository." } }),
      rec({ record_id: "r2", payload: { text: "Always use pnpm for this repository." } }),
      rec({ record_id: "r3", payload: { text: "항상 테스트를 먼저 실행해 주세요." } }),
      rec({ record_id: "r4", payload: { text: "Fix the bug please." } }),
    ]
    const preferences = extractPreferences(records)
    expect(preferences.length).toBeGreaterThanOrEqual(2)
    const pnpm = preferences.find((entry) => entry.statement.includes("pnpm"))
    expect(pnpm?.confidence).toBeGreaterThan(0.65)
    expect(pnpm?.evidence.length).toBeGreaterThanOrEqual(2)
    expect(preferences.some((entry) => entry.statement.includes("테스트"))).toBe(true)
    expect(preferences.some((entry) => entry.statement.includes("Fix the bug"))).toBe(false)
  })

  it("does not treat error logs and shell failures as preferences", () => {
    const preferences = extractPreferences([
      rec({ record_id: "e1", payload: { text: "npm error 403 Forbidden - You do not have access to this server." } }),
      rec({ record_id: "e2", payload: { text: "Error: connect ECONNREFUSED 127.0.0.1:5432. Never retry this." } }),
      rec({ record_id: "e3", payload: { text: "Always run the focused tests before committing." } }),
    ])
    expect(preferences).toHaveLength(1)
    expect(preferences[0]?.statement).toContain("Always run the focused tests")
  })

  it("merges preferences without losing earlier evidence", () => {
    const a = extractPreferences([rec({ record_id: "a", payload: { text: "Always use pnpm." } })])
    const b = extractPreferences([rec({ record_id: "b", payload: { text: "Always use pnpm." } })])
    const merged = mergePreferences(a, b)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.evidence.map((entry) => entry.record_id).sort()).toEqual(["a", "b"])
  })

  it("never writes an older analysis over a newer profile", () => {
    expect(shouldWriteProfile({ last_collected_at: "2026-02-01T00:00:00.000Z", last_record_ids: [] }, { last_collected_at: "2026-01-01T00:00:00.000Z", last_record_ids: [] })).toBe(false)
    expect(shouldWriteProfile({ last_collected_at: "2026-01-01T00:00:00.000Z", last_record_ids: [] }, { last_collected_at: "2026-01-01T00:00:00.000Z", last_record_ids: [] })).toBe(true)
    expect(comparePosition(undefined, { last_collected_at: "x", last_record_ids: [] })).toBe(-1)
    // Same millisecond: a cursor with additional IDs is newer; an older subset must not win.
    expect(
      shouldWriteProfile(
        { last_collected_at: "2026-01-01T00:00:00.000Z", last_record_ids: ["a", "b"] },
        { last_collected_at: "2026-01-01T00:00:00.000Z", last_record_ids: ["a"] },
      ),
    ).toBe(false)
    expect(
      shouldWriteProfile(
        { last_collected_at: "2026-01-01T00:00:00.000Z", last_record_ids: ["a"] },
        { last_collected_at: "2026-01-01T00:00:00.000Z", last_record_ids: ["a", "b"] },
      ),
    ).toBe(true)
  })

  it("schedules daily analysis and computes the next run", () => {
    expect(analysisDue(undefined, 24)).toBe(true)
    expect(analysisDue(new Date().toISOString(), 24)).toBe(false)
    expect(analysisDue("2026-01-01T00:00:00.000Z", 24, new Date("2026-01-02T00:00:01.000Z"))).toBe(true)
    expect(nextAnalysisAt("2026-01-01T00:00:00.000Z", 24)).toBe("2026-01-02T00:00:00.000Z")
  })

  it("builds a profile from tools, shell commands, and technical signals", () => {
    const profile = analyzeRecords(
      [
        rec({ record_id: "u1", payload: { text: "Use TypeScript and React. Always run tests." } }),
        rec({ record_id: "t1", kind: "message.assistant.tool", payload: { name: "shell", status: "completed", input: { command: "pnpm test" } } }),
        rec({ record_id: "s1", kind: "message.shell", payload: { command: "git status", output: "clean" } }),
      ],
      { scope: "project", developerID: "alice", projectID: "proj", allRecords: [] },
    )
    expect(profile?.tools[0]?.name).toBe("shell")
    expect(profile?.workflow.top_shell_commands).toContain("git status")
    expect(profile?.workflow.top_shell_commands).toContain("pnpm test")
    expect(profile?.technical.some((entry) => entry.name === "TypeScript")).toBe(true)
  })

  it("runs incrementally, advances checkpoints, and never edits canonical project context", async () => {
    const repo = await tempDir("analysis")
    const store = new RecordStore(repo, noopLogger)
    const projectDir = join(repo, "projects", "proj")
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, "conventions.md"), "# Rules\n- Reviewed rule\n", "utf8")
    await writeFile(join(projectDir, "shared-context.md"), "# Shared\n- Sentinel\n", "utf8")

    await store.append([
      rec({ record_id: "r1", collected_at: "2026-01-01T00:00:01.000Z", payload: { text: "Always use pnpm. We use TypeScript and React." } }),
      rec({
        record_id: "r2",
        kind: "message.assistant.tool",
        collected_at: "2026-01-01T00:00:02.000Z",
        session_id: "ses_1",
        message_id: "a1",
        payload: { name: "shell", input: { command: "pnpm test" } },
      }),
    ])

    const first = await runAnalysis({
      repoDir: repo,
      store,
      log: noopLogger,
      developerID: "alice",
      deviceID: "dev_a",
      projectID: "proj",
      projectName: "Project",
    })
    expect(first.ran).toBe(true)
    expect(first.profiles_written).toBeGreaterThanOrEqual(4)

    const globalProfile = JSON.parse(await readFile(join(repo, "developers", "alice", "profile.json"), "utf8"))
    expect(globalProfile.scope).toBe("global")
    expect(globalProfile.project_id).toBeUndefined()
    expect(globalProfile.preferences.some((entry: { statement: string }) => entry.statement.includes("pnpm"))).toBe(true)
    const checkpoint = await readCheckpoint(join(repo, "sync", "checkpoints", "alice", "proj.json"))
    expect(checkpoint?.version).toBe(1)

    const second = await runAnalysis({
      repoDir: repo,
      store,
      log: noopLogger,
      developerID: "alice",
      deviceID: "dev_a",
      projectID: "proj",
      projectName: "Project",
    })
    expect(second.ran).toBe(false)

    await store.append([
      rec({
        record_id: "r3",
        collected_at: "2026-01-02T00:00:01.000Z",
        message_id: "m3",
        payload: { text: "Never commit generated files. Prefer small commits." },
      }),
    ])
    const third = await runAnalysis({
      repoDir: repo,
      store,
      log: noopLogger,
      developerID: "alice",
      deviceID: "dev_a",
      projectID: "proj",
      projectName: "Project",
    })
    expect(third.ran).toBe(true)
    const updated = JSON.parse(await readFile(join(repo, "developers", "alice", "profile.json"), "utf8"))
    expect(updated.preferences.some((entry: { statement: string }) => entry.statement.includes("generated"))).toBe(true)
    expect((await readCheckpoint(join(repo, "sync", "checkpoints", "alice", "proj.json")))?.version).toBe(2)

    expect(await readFile(join(projectDir, "conventions.md"), "utf8")).toContain("Reviewed rule")
    expect(await readFile(join(projectDir, "shared-context.md"), "utf8")).toContain("Sentinel")
    const proposal = await readFile(join(repo, "analysis", "projects", "proj", "shared-context.proposal.md"), "utf8")
    expect(proposal).toContain("PROPOSAL ONLY")
    expect(proposal).toContain("Review checklist")
  })
})
