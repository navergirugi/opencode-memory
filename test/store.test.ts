import { describe, expect, it } from "vitest"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { LocalQueue, RecordStore, assertInside, parseJsonl, sessionRecordPath } from "../src/store.js"
import { noopLogger } from "../src/logger.js"
import { tempDir } from "./helpers.js"
import type { MemoryRecord } from "../src/types.js"

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const session = overrides.session_id ?? "ses_1"
  const message = overrides.message_id ?? "msg_1"
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
    collected_at: "2026-01-01T00:00:01.000Z",
    source: "api",
    payload: { text: "hello" },
    ...overrides,
  }
}

describe("record store", () => {
  it("appends only new records and deduplicates by record id", async () => {
    const repo = await tempDir("store")
    const store = new RecordStore(repo, noopLogger)
    const a = record()
    const b = record({ message_id: "msg_2", record_id: "ses_1:msg_2:user" })
    expect(await store.append([a, b])).toBe(2)
    expect(await store.append([a, b])).toBe(0)
    const records = await store.readSession("proj", "alice", "ses_1")
    expect(records).toHaveLength(2)
    expect(records.map((entry) => entry.record_id).sort()).toEqual(["ses_1:msg_1:user", "ses_1:msg_2:user"])
  })

  it("keeps distinct sessions in distinct files and separates projects", async () => {
    const repo = await tempDir("store")
    const store = new RecordStore(repo, noopLogger)
    await store.append([record({ session_id: "a" }), record({ session_id: "b" })])
    expect(await store.readSession("proj", "alice", "a")).toHaveLength(1)
    expect(await store.readSession("proj", "alice", "b")).toHaveLength(1)
    expect(await store.readSession("other", "alice", "a")).toHaveLength(0)
    expect(sessionRecordPath(repo, "proj", "alice", "a")).toContain("histories/proj/alice/sessions")
  })

  it("tolerates corrupt history lines", async () => {
    const repo = await tempDir("store")
    const store = new RecordStore(repo, noopLogger)
    const path = sessionRecordPath(repo, "proj", "alice", "ses_1")
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, `${JSON.stringify(record())}\nnot-json\n{"record_id":"x"}\n`, "utf8")
    const records = await store.readSession("proj", "alice", "ses_1")
    expect(records).toHaveLength(1)
    expect((await parseJsonl(await readFile(path, "utf8"))).invalid).toHaveLength(2)
  })

  it("drains the local queue, deduplicates crash leftovers, and removes files", async () => {
    const data = await tempDir("queue")
    const repo = await tempDir("store")
    const queue = new LocalQueue(data, noopLogger)
    const store = new RecordStore(repo, noopLogger)
    const a = record()
    const b = record({ message_id: "msg_2", record_id: "ses_1:msg_2:user" })
    expect(await queue.enqueue([a])).toBe(1)
    expect(await queue.enqueue([a, b])).toBe(1)
    expect(await queue.count()).toBe(2)

    // Simulate a crash: a duplicate line that was already appended.
    const file = join(data, "queue", `${(await import("../src/ids.js")).safeFileSegment("ses_1")}.jsonl`)
    await appendFile(file, `${JSON.stringify(a)}\n`, "utf8")
    const result = await queue.drain(store)
    expect(result.records).toBe(2)
    expect(await queue.count()).toBe(0)
    expect(await store.readSession("proj", "alice", "ses_1")).toHaveLength(2)
  })

  it("quarantines malformed queue lines instead of losing valid records", async () => {
    const data = await tempDir("queue")
    const repo = await tempDir("store")
    const queue = new LocalQueue(data, noopLogger)
    const store = new RecordStore(repo, noopLogger)
    const file = join(data, "queue", "bad.jsonl")
    await mkdir(join(data, "queue"), { recursive: true })
    await writeFile(file, `${JSON.stringify(record())}\n{oops\n`, "utf8")
    const result = await queue.drain(store)
    expect(result.records).toBe(1)
    expect(result.invalid).toBe(1)
    expect(await store.readSession("proj", "alice", "ses_1")).toHaveLength(1)
  })

  it("guards repository paths", () => {
    const base = "/tmp/base"
    expect(() => assertInside(base, "/tmp/base/../etc")).toThrow()
    expect(assertInside(base, "/tmp/base/ok")).toBe("/tmp/base/ok")
  })
})
