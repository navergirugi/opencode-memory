import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { safeFileSegment } from "./ids.js"
import type { Logger } from "./logger.js"
import { redactText } from "./redact.js"
import type { MemoryRecord } from "./types.js"

const MAX_RECORD_BYTES = 64 * 1024

export interface ParsedLines {
  records: MemoryRecord[]
  invalid: string[]
}

export function parseJsonl(text: string): ParsedLines {
  const records: MemoryRecord[] = []
  const invalid: string[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.length > MAX_RECORD_BYTES) {
      invalid.push(trimmed.slice(0, 200))
      continue
    }
    try {
      const parsed = JSON.parse(trimmed) as MemoryRecord
      if (!parsed || typeof parsed.record_id !== "string" || typeof parsed.session_id !== "string") {
        invalid.push(trimmed.slice(0, 200))
        continue
      }
      records.push(parsed)
    } catch {
      invalid.push(trimmed.slice(0, 200))
    }
  }
  return { records, invalid }
}

export function sessionRecordPath(repoDir: string, projectId: string, developerId: string, sessionId: string): string {
  return join(repoDir, "histories", projectId, developerId, "sessions", `${safeFileSegment(sessionId)}.jsonl`)
}

export function sessionRecordRelativePath(projectId: string, developerId: string, sessionId: string): string {
  return `histories/${projectId}/${developerId}/sessions/${safeFileSegment(sessionId)}.jsonl`
}

export class RecordStore {
  private readonly cache = new Map<string, { size: number; ids: Set<string> }>()

  constructor(
    private readonly repoDir: string,
    private readonly log: Logger,
  ) {}

  private async loadIndex(path: string): Promise<Set<string>> {
    if (!existsSync(path)) {
      this.cache.set(path, { size: 0, ids: new Set() })
      return this.cache.get(path)!.ids
    }
    let info
    try {
      info = await stat(path)
    } catch {
      return new Set()
    }
    const cached = this.cache.get(path)
    if (cached && cached.size === info.size) return cached.ids
    const text = await readFile(path, "utf8").catch(() => "")
    const parsed = parseJsonl(text)
    if (parsed.invalid.length > 0) {
      this.log.warn("Ignored malformed history lines while indexing", { path, count: parsed.invalid.length })
    }
    const ids = new Set(parsed.records.map((record) => record.record_id))
    this.cache.set(path, { size: info.size, ids })
    return ids
  }

  /** Append only records that are not already present. Returns the number appended. */
  async append(records: MemoryRecord[]): Promise<number> {
    const groups = new Map<string, MemoryRecord[]>()
    for (const record of records) {
      const path = sessionRecordPath(this.repoDir, record.project_id, record.developer_id, record.session_id)
      const group = groups.get(path) ?? []
      group.push(record)
      groups.set(path, group)
    }
    let appended = 0
    for (const [path, group] of groups) {
      await mkdir(dirname(path), { recursive: true })
      const ids = await this.loadIndex(path)
      const unique: MemoryRecord[] = []
      for (const record of group) {
        if (ids.has(record.record_id)) continue
        const line = JSON.stringify(record)
        if (line.length > MAX_RECORD_BYTES) {
          this.log.warn("Skipped an oversized record", { record: record.record_id, bytes: line.length })
          continue
        }
        ids.add(record.record_id)
        unique.push(record)
      }
      if (unique.length === 0) continue
      const body = `${unique.map((record) => JSON.stringify(record)).join("\n")}\n`
      await appendFile(path, body, { encoding: "utf8" })
      const info = await stat(path)
      this.cache.set(path, { size: info.size, ids })
      appended += unique.length
    }
    return appended
  }

  async readSession(projectId: string, developerId: string, sessionId: string): Promise<MemoryRecord[]> {
    const path = sessionRecordPath(this.repoDir, projectId, developerId, sessionId)
    if (!existsSync(path)) return []
    const text = await readFile(path, "utf8").catch(() => "")
    const parsed = parseJsonl(text)
    if (parsed.invalid.length > 0) {
      this.log.warn("Ignored malformed history lines", { path, count: parsed.invalid.length })
    }
    return parsed.records
  }

  /** Read all records for a project/developer pair (or all developers for a project). */
  async readProject(projectId: string, developerId?: string): Promise<MemoryRecord[]> {
    const root = join(this.repoDir, "histories", projectId)
    const developers = developerId ? [developerId] : await listDirectories(root)
    const records: MemoryRecord[] = []
    for (const developer of developers) {
      const sessionsDir = join(root, developer, "sessions")
      const files = await listFiles(sessionsDir, ".jsonl")
      for (const file of files) {
        const path = join(sessionsDir, file)
        const parsed = parseJsonl(await readFile(path, "utf8").catch(() => ""))
        if (parsed.invalid.length > 0) {
          this.log.warn("Ignored malformed history lines", { path, count: parsed.invalid.length })
        }
        records.push(...parsed.records)
      }
    }
    return records
  }

  async readDeveloper(developerId: string): Promise<MemoryRecord[]> {
    const root = join(this.repoDir, "histories")
    const projects = await listDirectories(root)
    const records: MemoryRecord[] = []
    for (const project of projects) {
      records.push(...(await this.readProject(project, developerId)))
    }
    return records
  }
}

async function listDirectories(path: string): Promise<string[]> {
  if (!existsSync(path)) return []
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

async function listFiles(path: string, suffix: string): Promise<string[]> {
  if (!existsSync(path)) return []
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => entry.name)
}

export interface QueueDrainResult {
  files: number
  records: number
  invalid: number
  errors: string[]
}

export class LocalQueue {
  constructor(
    private readonly dataDir: string,
    private readonly log: Logger,
  ) {}

  private fileFor(sessionId: string): string {
    return join(this.dataDir, "queue", `${safeFileSegment(sessionId)}.jsonl`)
  }

  async enqueue(records: MemoryRecord[]): Promise<number> {
    if (records.length === 0) return 0
    const groups = new Map<string, MemoryRecord[]>()
    for (const record of records) {
      const path = this.fileFor(record.session_id)
      const group = groups.get(path) ?? []
      group.push(record)
      groups.set(path, group)
    }
    let added = 0
    for (const [path, group] of groups) {
      await mkdir(dirname(path), { recursive: true })
      const existing = parseJsonl(await readFile(path, "utf8").catch(() => "")).records
      const ids = new Set(existing.map((record) => record.record_id))
      const unique = group.filter((record) => {
        if (ids.has(record.record_id)) return false
        ids.add(record.record_id)
        return true
      })
      if (unique.length === 0) continue
      await appendFile(path, `${unique.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8" })
      added += unique.length
    }
    return added
  }

  async count(): Promise<number> {
    const files = await listFiles(join(this.dataDir, "queue"), ".jsonl")
    let count = 0
    for (const file of files) {
      const parsed = parseJsonl(await readFile(join(this.dataDir, "queue", file), "utf8").catch(() => ""))
      count += parsed.records.length
    }
    return count
  }

  /** Move every queued record into the repository store. */
  async drain(store: RecordStore): Promise<QueueDrainResult> {
    const queueDir = join(this.dataDir, "queue")
    const files = await listFiles(queueDir, ".jsonl")
    const result: QueueDrainResult = { files: files.length, records: 0, invalid: 0, errors: [] }
    for (const file of files) {
      const path = join(queueDir, file)
      const raw = await readFile(path, "utf8").catch(() => "")
      const parsed = parseJsonl(raw)
      if (parsed.invalid.length > 0) {
        result.invalid += parsed.invalid.length
        const corruptPath = join(this.dataDir, "queue", "corrupt", `${file}.${Date.now()}.txt`)
        await mkdir(dirname(corruptPath), { recursive: true })
        await writeFile(corruptPath, parsed.invalid.map((line) => `${line}\n`).join(""), "utf8").catch(() => undefined)
        this.log.warn("Quarantined malformed queue lines", { path: corruptPath, count: parsed.invalid.length })
      }
      try {
        const appended = await store.append(parsed.records)
        result.records += appended
        // Duplicates are safe: the store deduplicates by record_id on the next drain.
        const { rm } = await import("node:fs/promises")
        await rm(path, { force: true })
      } catch (error) {
        result.errors.push(redactText(error instanceof Error ? error.message : String(error), 300))
        this.log.error("Could not flush queued records", { file, error: String(error) })
      }
    }
    return result
  }

  async remove(predicate: (path: string) => boolean): Promise<void> {
    const queueDir = join(this.dataDir, "queue")
    const files = await listFiles(queueDir, ".jsonl")
    const { rm } = await import("node:fs/promises")
    for (const file of files) {
      if (predicate(file)) await rm(join(queueDir, file), { force: true })
    }
  }
}

/** Ensure a path stays inside a base directory. */
export function assertInside(base: string, target: string): string {
  const resolvedBase = resolve(base)
  const resolvedTarget = resolve(target)
  const rel = relative(resolvedBase, resolvedTarget)
  if (rel.startsWith("..") || rel === "") {
    throw new Error("Path escapes the memory repository.")
  }
  return resolvedTarget
}
