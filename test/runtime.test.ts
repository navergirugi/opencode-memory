import { afterEach, describe, expect, it } from "vitest"
import { readFile, rename } from "node:fs/promises"
import { join } from "node:path"
import plugin from "../src/index.js"
import { gitOrThrow, runGit } from "../src/git.js"
import { sessionRecordRelativePath } from "../src/store.js"
import { createBareRemote, tempDir } from "./helpers.js"
import type { SourceMessage, SourceSession } from "../src/collector.js"

const savedLocal = process.env.OPENCODE_MEMORY_ALLOW_LOCAL_REPOS

afterEach(() => {
  if (savedLocal === undefined) delete process.env.OPENCODE_MEMORY_ALLOW_LOCAL_REPOS
  else process.env.OPENCODE_MEMORY_ALLOW_LOCAL_REPOS = savedLocal
})

const CANONICAL = "/tmp/opencode-memory-e2e-project"

interface Harness {
  tool: { execute: (input: Record<string, unknown>) => Promise<{ content: string }> }
  hooks: {
    prompt?: (event: unknown) => unknown
    tool?: (event: unknown) => unknown
    context?: (event: unknown) => unknown
  }
  commands: Map<string, (input: { sessionID: string; prompt: { text: string } }) => Promise<void>>
  synthetic: string[]
  generatedPrompts: string[]
  cleanup: () => Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error("Timed out waiting for the memory runtime")
    await sleep(25)
  }
}

async function makeHarness(dataDir: string, sessions: Map<string, SourceSession>, messages: Map<string, SourceMessage[]>): Promise<Harness> {
  let toolDef: { execute: (input: Record<string, unknown>) => Promise<{ content: string }> } | undefined
  const hooks: Harness["hooks"] = {}
  const commands = new Map<string, (input: { sessionID: string; prompt: { text: string } }) => Promise<void>>()
  const synthetic: string[] = []
  const generatedPrompts: string[] = []

  const ctx = {
    options: { dataDir, scan_interval_seconds: 3_600, sync_interval_seconds: 3_600, analysis_interval_hours: 24 },
    location: {
      directory: CANONICAL,
      project: { id: "oc_proj", directory: CANONICAL, canonical: CANONICAL },
    },
    session: {
      list: async (input: { project?: string }) => ({
        data: [...sessions.values()].filter((session) => !input.project || session.projectID === input.project),
      }),
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID)
        if (!session) throw new Error(`Unknown session ${sessionID}`)
        return session
      },
      context: async ({ sessionID }: { sessionID: string }) => messages.get(sessionID) ?? [],
      hook: async (name: string, fn: (event: unknown) => unknown) => {
        hooks[name as keyof Harness["hooks"]] = fn
      },
      synthetic: async ({ text }: { text: string }) => {
        synthetic.push(text)
      },
    },
    tool: {
      transform: async (edit: (editor: { add: (definition: typeof toolDef) => void }) => void) => {
        edit({ add: (definition) => (toolDef = definition) })
      },
      hook: async (name: string, fn: (event: unknown) => unknown) => {
        if (name === "execute.after") hooks.tool = fn
      },
    },
    command: {
      transform: async (edit: (editor: { add: (definition: { name: string; execute: (input: { sessionID: string; prompt: { text: string } }) => Promise<void> }) => void }) => void) => {
        edit({ add: (definition) => commands.set(definition.name, definition.execute) })
      },
    },
    generate: {
      text: async ({ prompt }: { prompt: string }) => {
        generatedPrompts.push(prompt)
        return { text: "# Deep profile\n- Short questions and complete code." }
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) await sleep(25)
        },
      }),
    },
  }

  const cleanup = await plugin.setup(ctx as never)
  if (!toolDef) throw new Error("The plugin did not register its tool")
  return {
    tool: toolDef,
    hooks,
    commands,
    synthetic,
    generatedPrompts,
    cleanup: async () => {
      await cleanup?.()
    },
  }
}

async function remoteHead(remote: string): Promise<string | undefined> {
  const result = await runGit(["rev-parse", "--verify", "refs/heads/main"], { cwd: remote })
  return result.code === 0 ? result.stdout.trim() : undefined
}

function session(id: string, projectID: string): SourceSession {
  return {
    id,
    projectID,
    title: `Session ${id}`,
    time: { created: Date.parse("2026-01-01T00:00:00.000Z"), updated: Date.parse("2026-01-01T00:10:00.000Z") },
    location: { directory: CANONICAL, projectID, project: { id: projectID, canonical: CANONICAL } },
  }
}

describe("runtime end to end", () => {
  it("sets up, collects, deduplicates, syncs, analyzes, and injects context", async () => {
    process.env.OPENCODE_MEMORY_ALLOW_LOCAL_REPOS = "1"
    const remote = await createBareRemote()
    const dataDir = await tempDir("e2e")

    const sessions = new Map<string, SourceSession>([
      ["ses_1", session("ses_1", "oc_proj")],
      ["ses_other", session("ses_other", "oc_other")],
    ])
    const messages = new Map<string, SourceMessage[]>([
      [
        "ses_1",
        [
          { id: "msg_1", type: "user", text: "We use TypeScript and React. Always run pnpm test.", time: { created: Date.parse("2026-01-01T00:01:00.000Z") } },
          {
            id: "msg_assistant",
            type: "assistant",
            time: { created: Date.parse("2026-01-01T00:02:00.000Z") },
            content: [
              { type: "text", text: "Running the test suite now." },
              { type: "tool", id: "call_1", name: "shell", state: { status: "completed", input: { command: "pnpm test" }, content: "passed" } },
            ],
          },
        ],
      ],
    ])

    const harness = await makeHarness(dataDir, sessions, messages)
    try {
      const setup = await harness.tool.execute({
        action: "setup",
        repo_url: remote,
        developer_id: "alice",
        developer_name: "Alice",
        device_name: "MacBook",
      })
      expect(setup.content).toContain("OpenCode Memory is configured.")
      await waitFor(async () => {
        const status = await harness.tool.execute({ action: "status" })
        return /Collected sessions: [1-9]/.test(status.content)
      })

      // Polling collection already ran during startup and pushed the session history.
      await harness.tool.execute({ action: "sync" })
      const historyRelative = sessionRecordRelativePath("oc_proj", "alice", "ses_1")
      const history = await gitOrThrow(["show", `refs/heads/main:${historyRelative}`], { cwd: remote })
      expect(history).toContain('"kind":"session.meta"')
      expect(history).toContain('"kind":"message.user"')

      // Prompt and tool hooks share the same record IDs as polling, so dedupe must hold.
      await harness.hooks.prompt?.({
        sessionID: "ses_1",
        messageID: "msg_1",
        prompt: { text: "Always run pnpm test. Token ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
        delivery: "immediate",
      })
      await harness.hooks.tool?.({
        sessionID: "ses_1",
        messageID: "msg_assistant",
        id: "call_1",
        tool: "shell",
        input: { command: "pnpm test" },
        status: "completed",
        result: "passed",
      })
      await waitFor(async () => {
        const status = await harness.tool.execute({ action: "status" })
        return /Pending local records: [1-9]/.test(status.content)
      })

      const sync = await harness.tool.execute({ action: "sync" })
      expect(sync.content).toContain("Sync complete")

      const merged = await gitOrThrow(["show", `refs/heads/main:${historyRelative}`], { cwd: remote })
      const ids = merged
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { record_id: string })
        .map((record) => record.record_id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(merged).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789")

      // A prompt that was not already stored (for example after compaction) is captured
      // by the live hook and its secret is masked before it reaches Git.
      await harness.hooks.prompt?.({
        sessionID: "ses_1",
        messageID: "msg_secret",
        prompt: { text: "Deploy with this token ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
        delivery: "immediate",
      })
      await waitFor(async () => {
        const status = await harness.tool.execute({ action: "status" })
        return /Pending local records: [1-9]/.test(status.content)
      })
      await harness.tool.execute({ action: "sync" })
      const withSecret = await gitOrThrow(["show", `refs/heads/main:${historyRelative}`], { cwd: remote })
      expect(withSecret).toContain("[REDACTED]")
      expect(withSecret).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789")
      expect(withSecret).toContain("msg_secret")

      const analysis = await harness.tool.execute({ action: "analyze" })
      expect(analysis.content).toContain("Analysis complete")

      const profile = await harness.tool.execute({ action: "profile" })
      expect(profile.content).toContain("OpenCode Memory developer profile")
      expect(profile.content).toContain("### Global profile")
      expect(profile.content).toContain("pnpm")

      const deep = await harness.tool.execute({ action: "deep_analyze", include_messages: true })
      expect(deep.content).toContain("Deep profile generated")
      expect(harness.generatedPrompts.at(-1)).toContain("Recent user messages")
      expect(harness.generatedPrompts.at(-1)).toContain("pnpm")
      const deepPath = join(dataDir, "repo", "developers", "alice", "deep-profile.md")
      expect(await readFile(deepPath, "utf8")).toContain("# Deep profile")

      const event = { sessionID: "ses_1", system: [] as { type: string; text: string }[] }
      await harness.hooks.context?.(event)
      expect(event.system).toHaveLength(1)
      expect(event.system[0]?.text).toContain("<!-- opencode-memory:context:v1 -->")
      expect(event.system[0]?.text).toContain("Project conventions")
      expect(event.system[0]?.text).toContain("pnpm")

      // A second application must not duplicate the injected block.
      await harness.hooks.context?.(event)
      expect(event.system).toHaveLength(1)

      // A session from another project must never receive this project's context.
      const other = { sessionID: "ses_other", system: [] as { type: string; text: string }[] }
      await harness.hooks.context?.(other)
      expect(other.system).toHaveLength(0)

      const status = await harness.tool.execute({ action: "status" })
      expect(status.content).toContain("Setup: complete")
      expect(status.content).toContain("Pending local records: 0")
      expect(status.content).toContain("Alice")

      const doctor = await harness.tool.execute({ action: "doctor" })
      expect(doctor.content).toContain("[ok] read-access")
      expect(doctor.content).toContain("[ok] write-access")

      await harness.commands.get("memory-status")?.({ sessionID: "ses_1", prompt: { text: "" } })
      expect(harness.synthetic.at(-1)).toContain("OpenCode Memory status")

      await harness.commands.get("memory-profile")?.({ sessionID: "ses_1", prompt: { text: "" } })
      expect(harness.synthetic.at(-1)).toContain("OpenCode Memory developer profile")

      const generatedBefore = harness.generatedPrompts.length
      await harness.commands.get("memory-deep-analyze")?.({ sessionID: "ses_1", prompt: { text: "--no-messages" } })
      expect(harness.synthetic.at(-1)).toContain("오늘 이미 심층 분석을 실행했습니다")
      expect(harness.generatedPrompts.length).toBe(generatedBefore)

      const profilePath = join(dataDir, "repo", "developers", "alice", "profile.json")
      const beforeRepeat = JSON.parse(await readFile(profilePath, "utf8")) as { generated_from: unknown; stats: { records: number } }
      const repeat = await harness.tool.execute({ action: "analyze" })
      expect(repeat.content).toContain("Analysis complete")
      const afterRepeat = JSON.parse(await readFile(profilePath, "utf8")) as { generated_from: unknown; stats: { records: number } }
      expect(afterRepeat.generated_from).toEqual(beforeRepeat.generated_from)
      expect(afterRepeat.stats.records).toBe(beforeRepeat.stats.records)
    } finally {
      await harness.cleanup()
    }
  }, 30_000)

  it("keeps working offline, queues locally, and syncs after the remote returns", async () => {
    process.env.OPENCODE_MEMORY_ALLOW_LOCAL_REPOS = "1"
    const remote = await createBareRemote()
    const dataDir = await tempDir("e2e-offline")

    const sessions = new Map<string, SourceSession>([["ses_1", session("ses_1", "oc_proj")]])
    const messages = new Map<string, SourceMessage[]>([
      ["ses_1", [{ id: "msg_1", type: "user", text: "Prefer small commits.", time: { created: Date.parse("2026-01-01T00:01:00.000Z") } }]],
    ])

    const harness = await makeHarness(dataDir, sessions, messages)
    try {
      const setup = await harness.tool.execute({ action: "setup", repo_url: remote, developer_id: "bob" })
      expect(setup.content).toContain("configured")
      await waitFor(async () => {
        const status = await harness.tool.execute({ action: "status" })
        return /Collected sessions: [1-9]/.test(status.content) && !status.content.includes("Last analysis: never")
      })

      const hidden = `${remote}.offline`
      await rename(remote, hidden)

      await harness.hooks.prompt?.({
        sessionID: "ses_1",
        messageID: "msg_offline",
        prompt: { text: "Never commit generated files." },
        delivery: "immediate",
      })
      await waitFor(async () => {
        const status = await harness.tool.execute({ action: "status" })
        return /Pending local records: [1-9]/.test(status.content)
      })

      const failed = await harness.tool.execute({ action: "sync" })
      expect(failed.content).toContain("Sync failed")

      const offline = await harness.tool.execute({ action: "status" })
      expect(offline.content).toContain("Sync error")
      expect(offline.content).toMatch(/unpushed commits\/changes: [1-9]/)

      await rename(hidden, remote)
      const recovered = await harness.tool.execute({ action: "sync" })
      expect(recovered.content).toContain("Sync complete")
      const after = await harness.tool.execute({ action: "status" })
      expect(after.content).toContain("Pending local records: 0")
      expect(after.content).toContain("unpushed commits/changes: 0")
    } finally {
      await harness.cleanup()
    }
  }, 30_000)
})
