import { describe, expect, it } from "vitest"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { Collector, type SourceMessage, type SourceSession } from "../src/collector.js"
import { LocalQueue, parseJsonl } from "../src/store.js"
import { createConfigFromSetup } from "../src/config.js"
import { noopLogger } from "../src/logger.js"
import { tempDir } from "./helpers.js"
import type { MemoryRecord } from "../src/types.js"

const PROJECT = "opencode-project-1"

function session(id: string, projectID = PROJECT): SourceSession {
  return {
    id,
    projectID,
    title: `Session ${id}`,
    time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
    location: { directory: "/work/project", project: { id: projectID, canonical: "/work/project" } },
  }
}

const user: SourceMessage = {
  id: "msg_user",
  type: "user",
  time: { created: 1_700_000_000_000 },
  text: "Please always run tests. token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  files: [{ uri: "file:///work/project/src/index.ts", name: "index.ts", mime: "text/typescript" }],
}

const assistant: SourceMessage = {
  id: "msg_assistant",
  type: "assistant",
  time: { created: 1_700_000_001_000 },
  agent: "build",
  model: { providerID: "test", id: "model" },
  content: [
    { type: "text", text: "I will run the tests. OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456" },
    {
      type: "tool",
      id: "call_1",
      name: "shell",
      state: { status: "completed", input: { command: "pnpm test", password: "hunter2" }, content: [{ type: "text", text: "ok 12 tests" }] },
      time: { created: 1_700_000_002_000 },
    },
  ],
}

const shell: SourceMessage = {
  id: "msg_shell",
  type: "shell",
  time: { created: 1_700_000_003_000 },
  command: "git status",
  status: "exited",
  exit: 0,
  output: { output: "clean" },
}

function makeSessions(sessions: SourceSession[], messages: Record<string, SourceMessage[]>) {
  return {
    list: async (input: { project?: string; limit?: number }) => ({
      data: sessions.filter((entry) => !input.project || entry.projectID === input.project).slice(0, input.limit ?? 50),
    }),
    get: async ({ sessionID }: { sessionID: string }) => {
      const found = sessions.find((entry) => entry.id === sessionID)
      if (!found) throw new Error("not found")
      return found
    },
    context: async ({ sessionID }: { sessionID: string }) => messages[sessionID] ?? [],
  }
}

async function queueRecords(dataDir: string): Promise<MemoryRecord[]> {
  const dir = join(dataDir, "queue")
  const files = await readdir(dir).catch(() => [] as string[])
  const records: MemoryRecord[] = []
  for (const file of files.filter((entry) => entry.endsWith(".jsonl"))) {
    records.push(...parseJsonl(await readFile(join(dir, file), "utf8")).records)
  }
  return records
}

function makeCollector(dataDir: string, sessions: ReturnType<typeof makeSessions>, all = false) {
  const config = createConfigFromSetup({
    repoUrl: "https://github.com/owner/repo",
    developerId: "alice",
    deviceId: "dev_a",
    opencodeProjectId: PROJECT,
    projectId: "proj-a",
    options: { collect_all_projects: all },
  })
  return new Collector({
    config,
    queue: new LocalQueue(dataDir, noopLogger),
    log: noopLogger,
    location: { directory: "/work/project", projectID: PROJECT, canonical: "/work/project" },
    sessions,
  })
}

describe("collector", () => {
  it("collects session metadata and messages, masks secrets, and deduplicates", async () => {
    const dataDir = await tempDir("collector")
    const sessions = makeSessions([session("ses_1")], { ses_1: [user, assistant, shell] })
    const collector = makeCollector(dataDir, sessions)

    const first = await collector.collectRecent()
    expect(first.sessions).toBe(1)
    expect(first.records).toBeGreaterThanOrEqual(5)
    const records = await queueRecords(dataDir)
    expect(records.some((entry) => entry.kind === "message.user")).toBe(true)
    expect(records.filter((entry) => entry.kind === "message.assistant.text")).toHaveLength(1)
    expect(records.filter((entry) => entry.kind === "message.assistant.tool")).toHaveLength(1)
    expect(records.some((entry) => entry.kind === "message.shell")).toBe(true)
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain("ghp_")
    expect(serialized).not.toContain("sk-abcdef")
    expect(serialized).not.toContain("hunter2")
    expect(serialized).toContain("index.ts")

    const second = await collector.collectRecent()
    expect(second.records).toBe(0)
    expect((await queueRecords(dataDir)).length).toBe(records.length)
  })

  it("merges prompt-hook records with API records without duplicates", async () => {
    const dataDir = await tempDir("collector")
    const messages: Record<string, SourceMessage[]> = { ses_1: [user] }
    const sessions = makeSessions([session("ses_1")], messages)
    const collector = makeCollector(dataDir, sessions)

    await collector.collectPrompt({
      sessionID: "ses_1",
      messageID: "msg_user",
      prompt: { text: "Please always run tests. token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
      delivery: "steer",
    })
    expect((await queueRecords(dataDir)).filter((entry) => entry.record_id === "ses_1:msg_user:user")).toHaveLength(1)
    await collector.collectSession("ses_1")
    expect((await queueRecords(dataDir)).filter((entry) => entry.record_id === "ses_1:msg_user:user")).toHaveLength(1)
  })

  it("does not mix projects when collect_all_projects is false", async () => {
    const dataDir = await tempDir("collector")
    const sessions = makeSessions([session("ses_1"), session("ses_2", "other-project")], {
      ses_1: [user],
      ses_2: [user],
    })
    const collector = makeCollector(dataDir, sessions)
    const records = (await collector.collectRecent()).records
    expect(records).toBeGreaterThan(0)
    const queued = await queueRecords(dataDir)
    expect(new Set(queued.map((entry) => entry.project_id))).toEqual(new Set(["proj-a"]))
    expect(queued.some((entry) => entry.session_id === "ses_2")).toBe(false)
  })

  it("collects sessions from other projects when collect_all_projects is true", async () => {
    const dataDir = await tempDir("collector")
    const sessions = makeSessions([session("ses_1"), session("ses_2", "other-project")], {
      ses_1: [user],
      ses_2: [user],
    })
    const collector = makeCollector(dataDir, sessions, true)
    await collector.collectRecent()
    const queued = await queueRecords(dataDir)
    expect(queued.some((entry) => entry.session_id === "ses_2")).toBe(true)
    expect(new Set(queued.map((entry) => entry.project_id)).size).toBe(2)
  })

  it("uses the OpenCode project id as the stable default project id", async () => {
    const dataDir = await tempDir("collector")
    const sessions = makeSessions([session("ses_1")], { ses_1: [user] })
    const collector = makeCollector(dataDir, sessions)
    collector["deps"].config.project_ids = {}
    await collector.collectRecent()
    const queued = await queueRecords(dataDir)
    expect(queued[0]?.project_id).toBe(PROJECT)
  })

  it("captures durable text events and deduplicates them against API records", async () => {
    const dataDir = await tempDir("collector")
    const sessions = makeSessions([session("ses_1")], { ses_1: [assistant] })
    const collector = makeCollector(dataDir, sessions)
    await collector.collectSession("ses_1")
    const before = (await queueRecords(dataDir)).length
    const added = await collector.collectEvent({
      type: "session.text.ended",
      created: 1_700_000_001_000,
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", ordinal: 0, text: "I will run the tests." },
    })
    expect(added).toBe(0)
    expect((await queueRecords(dataDir)).length).toBe(before)
  })
})
