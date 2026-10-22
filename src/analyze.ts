import { existsSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { ANALYZER_VERSION, SCHEMA_VERSION } from "./types.js"
import type {
  AnalysisRunResult,
  Checkpoint,
  Cursor,
  Evidence,
  MemoryRecord,
  Preference,
  Profile,
  TechSignal,
} from "./types.js"
import type { Logger } from "./logger.js"
import { isAfterCursor, nowIso, shortHash } from "./ids.js"
import type { RecordStore } from "./store.js"
import { redactText } from "./redact.js"

export class StaleCheckpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StaleCheckpointError"
  }
}

const TECH_DICTIONARY: { name: string; category: string; pattern: RegExp }[] = [
  { name: "TypeScript", category: "language", pattern: /\btypescript\b|\bts\b/gi },
  { name: "JavaScript", category: "language", pattern: /\bjavascript\b|\bnode(?:\.js)?\b/gi },
  { name: "React", category: "frontend", pattern: /\breact(?:\.js)?\b/gi },
  { name: "Next.js", category: "frontend", pattern: /\bnext(?:\.js)?\b/gi },
  { name: "Vue", category: "frontend", pattern: /\bvue(?:\.js)?\b/gi },
  { name: "Svelte", category: "frontend", pattern: /\bsvelte(?:kit)?\b/gi },
  { name: "Solid", category: "frontend", pattern: /\bsolid(?:js|start)?\b/gi },
  { name: "Tailwind CSS", category: "frontend", pattern: /\btailwind(?:css)?\b/gi },
  { name: "Python", category: "language", pattern: /\bpython\b/gi },
  { name: "Rust", category: "language", pattern: /\brust\b/gi },
  { name: "Go", category: "language", pattern: /\bgolang\b|\bgo(?:lang)?\b/gi },
  { name: "Java", category: "language", pattern: /\bjava\b(?!script)/gi },
  { name: "Kotlin", category: "language", pattern: /\bkotlin\b/gi },
  { name: "Swift", category: "language", pattern: /\bswift\b/gi },
  { name: "Ruby", category: "language", pattern: /\bruby\b/gi },
  { name: "PHP", category: "language", pattern: /\bphp\b/gi },
  { name: "C#", category: "language", pattern: /\bc#|\.net\b/gi },
  { name: "PostgreSQL", category: "database", pattern: /\bpostgres(?:ql)?\b/gi },
  { name: "SQLite", category: "database", pattern: /\bsqlite\b/gi },
  { name: "MySQL", category: "database", pattern: /\bmysql\b/gi },
  { name: "MongoDB", category: "database", pattern: /\bmongo(?:db)?\b/gi },
  { name: "Redis", category: "database", pattern: /\bredis\b/gi },
  { name: "Prisma", category: "database", pattern: /\bprisma\b/gi },
  { name: "Drizzle", category: "database", pattern: /\bdrizzle\b/gi },
  { name: "GraphQL", category: "api", pattern: /\bgraphql\b/gi },
  { name: "REST", category: "api", pattern: /\brest(?:ful)?\b/gi },
  { name: "gRPC", category: "api", pattern: /\bgrpc\b/gi },
  { name: "Docker", category: "infrastructure", pattern: /\bdocker\b/gi },
  { name: "Kubernetes", category: "infrastructure", pattern: /\bkubernetes\b|\bk8s\b/gi },
  { name: "Terraform", category: "infrastructure", pattern: /\bterraform\b/gi },
  { name: "AWS", category: "cloud", pattern: /\baws\b|\bamazon web services\b/gi },
  { name: "Google Cloud", category: "cloud", pattern: /\bgcp\b|\bgoogle cloud\b/gi },
  { name: "Azure", category: "cloud", pattern: /\bazure\b/gi },
  { name: "Cloudflare", category: "cloud", pattern: /\bcloudflare\b|\bworkers\b/gi },
  { name: "Vitest", category: "testing", pattern: /\bvitest\b/gi },
  { name: "Jest", category: "testing", pattern: /\bjest\b/gi },
  { name: "Playwright", category: "testing", pattern: /\bplaywright\b/gi },
  { name: "Bun", category: "runtime", pattern: /\bbun\b/gi },
  { name: "Deno", category: "runtime", pattern: /\bdeno\b/gi },
  { name: "Electron", category: "desktop", pattern: /\belectron\b/gi },
  { name: "Tauri", category: "desktop", pattern: /\btauri\b/gi },
  { name: "React Native", category: "mobile", pattern: /\breact native\b/gi },
  { name: "Flutter", category: "mobile", pattern: /\bflutter\b/gi },
]

const EXTENSIONS: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  c: "C",
  h: "C",
  cpp: "C++",
  hpp: "C++",
  sql: "SQL",
  sh: "Shell",
  zsh: "Shell",
  md: "Markdown",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
}

const PREFERENCE_CUE =
  /(\balways\b|\bnever\b|\bprefer\b|\bavoid\b|\binstead of\b|\bmake sure\b|\bdon't\b|\bdo not\b|항상|절대|선호|하지\s?마|대신|꼭|되도록|주의)/i

/**
 * Error logs and shell output often contain words such as "do not" or "never".
 * They are not user preferences, so keep them out of the inferred profile.
 */
const LOG_LIKE = [
  /^(?:npm|yarn|pnpm|bun|node|deno|python|java|go|cargo|git)\s+(?:error|warn(?:ing)?|info|fatal)\b/i,
  /^(?:error|fatal|exception|traceback|failed|failure)\b/i,
  /\b(?:ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|ERR_[A-Z0-9_]+)\b/,
  /\b(?:403|404|500)\b.*\b(?:forbidden|not found|internal server error|unauthorized)\b/i,
  /\bat\s+\S+\s+\([^)]*:\d+:\d+\)/,
  /\byou do not have access to\b/i,
  /\btwo-factor authentication\b.*\b(?:required|enabled|bypass)\b/i,
  /^\s*[{\[]\s*"error"/,
]

export interface AnalysisOptions {
  repoDir: string
  store: RecordStore
  log: Logger
  developerID: string
  deviceID: string
  projectID?: string
  projectName?: string
  force?: boolean
  now?: Date
  analyzerVersion?: string
}

export async function runAnalysis(options: AnalysisOptions): Promise<AnalysisRunResult> {
  const now = options.now ?? new Date()
  const analyzerVersion = options.analyzerVersion ?? ANALYZER_VERSION
  const result: AnalysisRunResult = { ran: false, reason: "no-new-records", profiles_written: 0 }
  let wrote = false
  const globalCheckpointPath = checkpointPath(options.repoDir, options.developerID, "global")
  const globalInput = await options.store.readDeveloper(options.developerID)
  const globalRun = await analyzeScope({
    options,
    scope: "global",
    records: globalInput,
    checkpointPath: globalCheckpointPath,
    now,
    analyzerVersion,
  })
  if (globalRun.wrote) {
    result.profiles_written += globalRun.filesWritten
    result.global_cursor = globalRun.cursor
    wrote = true
  }

  if (options.projectID) {
    const projectCheckpointPath = checkpointPath(options.repoDir, options.developerID, options.projectID)
    const projectRecords = await options.store.readProject(options.projectID, options.developerID)
    const projectRun = await analyzeScope({
      options,
      scope: "project",
      records: projectRecords,
      checkpointPath: projectCheckpointPath,
      now,
      analyzerVersion,
    })
    if (projectRun.wrote) {
      result.profiles_written += projectRun.filesWritten
      result.project_cursor = projectRun.cursor
      wrote = true
    }
    const proposal = await writeSharedProposal(options, projectRecords, now, analyzerVersion)
    if (proposal) result.profiles_written += 1
  }

  result.ran = wrote || result.profiles_written > 0
  if (!result.ran) result.reason = "no-new-records"
  return result
}

interface ScopeRun {
  wrote: boolean
  cursor?: Cursor
  filesWritten: number
}

async function analyzeScope(input: {
  options: AnalysisOptions
  scope: "global" | "project"
  records: MemoryRecord[]
  checkpointPath: string
  now: Date
  analyzerVersion: string
}): Promise<ScopeRun> {
  const { options, scope, records, checkpointPath, now, analyzerVersion } = input
  const checkpoint = await readCheckpoint(checkpointPath)
  const fresh = options.force ? records : records.filter((record) => isAfterCursor(record, checkpoint?.cursor))
  if (fresh.length === 0) return { wrote: false, filesWritten: 0 }

  const previousProfile = scope === "global" ? await readProfile(globalProfilePath(options.repoDir, options.developerID)) : await readProfile(projectProfilePath(options.repoDir, options.projectID!, options.developerID))
  const delta = analyzeRecords(fresh, {
    scope,
    developerID: options.developerID,
    projectID: scope === "project" ? options.projectID : undefined,
    previous: previousProfile ?? undefined,
    allRecords: records,
  })
  if (!delta) return { wrote: false, filesWritten: 0 }

  const cursor = cursorFor(fresh, previousProfile?.generated_from)
  delta.generated_from = cursor
  delta.generated_at = now.toISOString()
  delta.analyzer_version = analyzerVersion

  const expectedVersion = checkpoint?.version ?? 0
  const latestCheckpoint = await readCheckpoint(checkpointPath)
  if ((latestCheckpoint?.version ?? 0) !== expectedVersion) {
    options.log.warn("Skipping analysis because another device advanced the checkpoint", { scope, projectID: options.projectID })
    throw new StaleCheckpointError("The analysis checkpoint changed on another device. The next run will analyze the new range.")
  }

  const paths =
    scope === "global"
      ? [globalProfilePath(options.repoDir, options.developerID), detailAnalysisPath(options.repoDir, options.developerID)]
      : [
          projectProfilePath(options.repoDir, options.projectID!, options.developerID),
          projectAnalysisPath(options.repoDir, options.projectID!, options.developerID),
        ]

  let wroteAny = false
  for (const path of paths) {
    const existing = await readProfile(path)
    if (!shouldWriteProfile(existing?.generated_from, delta.generated_from)) {
      options.log.warn("Skipped writing an older profile over newer analysis", { path })
      continue
    }
    await atomicWriteJson(path, delta)
    wroteAny = true
  }
  if (!wroteAny) return { wrote: false, filesWritten: 0 }

  const next: Checkpoint = {
    schema_version: SCHEMA_VERSION,
    analyzer_version: analyzerVersion,
    scope,
    developer_id: options.developerID,
    project_id: options.projectID,
    device_id: options.deviceID,
    version: expectedVersion + 1,
    run_id: `${now.toISOString()}-${shortHash(options.deviceID + now.toISOString(), 8)}`,
    cursor,
    records_processed: fresh.length,
    updated_at: now.toISOString(),
  }
  await atomicWriteJson(checkpointPath, next)
  return { wrote: true, cursor, filesWritten: paths.length }
}

export function analyzeRecords(
  fresh: MemoryRecord[],
  input: {
    scope: "global" | "project"
    developerID: string
    projectID?: string
    previous?: Profile
    allRecords: MemoryRecord[]
  },
): Profile | null {
  if (fresh.length === 0) return null
  const previous = input.previous
  const all = mergeRecords(input.allRecords, fresh)
  const stats = computeStats(all)
  const tools = mergeCounts(previous?.tools ?? [], countTools(fresh))
  const languages = mergeCounts(previous?.languages ?? [], countLanguages(fresh))
  const technical = mergeTech(previous?.technical ?? [], extractTech(fresh))
  const preferences = mergePreferences(previous?.preferences ?? [], extractPreferences(fresh))
  const commands = topCommands(all)

  return {
    schema_version: SCHEMA_VERSION,
    scope: input.scope,
    developer_id: input.developerID,
    project_id: input.projectID,
    analyzer_version: ANALYZER_VERSION,
    generated_at: new Date().toISOString(),
    generated_from: cursorFor(fresh, previous?.generated_from),
    stats,
    tools,
    languages,
    technical,
    preferences,
    workflow: {
      average_user_message_chars: averageUserMessageLength(all),
      top_shell_commands: commands,
    },
  }
}

export function extractPreferences(records: MemoryRecord[]): Preference[] {
  const byId = new Map<string, Preference>()
  for (const record of records) {
    if (record.kind !== "message.user") continue
    const text = typeof record.payload.text === "string" ? record.payload.text : ""
    if (!text) continue
    for (const line of text.split(/\n+/)) {
      // A log line can contain a fragment that looks like a preference
      // ("... Never retry this."). Skip the whole line rather than learning it.
      if (LOG_LIKE.some((pattern) => pattern.test(line))) continue
      for (const sentence of splitSentences(line)) {
        if (sentence.length < 12 || sentence.length > 320) continue
        if (!PREFERENCE_CUE.test(sentence)) continue
        if (LOG_LIKE.some((pattern) => pattern.test(sentence))) continue
        if (/^(?:please|부탁|해줘|고마워|thanks?)[\s.!?]*$/i.test(sentence)) continue
        const quote = redactText(sentence, 200)
        const id = `pref-${shortHash(normalize(sentence), 12)}`
        const evidence: Evidence = { record_id: record.record_id, quote }
        const existing = byId.get(id)
        if (existing) {
          if (!existing.evidence.some((entry) => entry.record_id === evidence.record_id)) {
            existing.evidence.push(evidence)
            existing.evidence = existing.evidence.slice(0, 8)
            existing.confidence = Math.min(0.9, existing.confidence + 0.1)
            existing.origin = "repeated"
          }
        } else {
          byId.set(id, {
            id,
            statement: quote,
            confidence: 0.65,
            evidence: [evidence],
            origin: "explicit",
          })
        }
        if (byId.size >= 40) break
      }
      if (byId.size >= 40) break
    }
  }
  return [...byId.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 20)
}

export function mergePreferences(previous: Preference[], delta: Preference[]): Preference[] {
  const map = new Map(previous.map((entry) => [entry.id, { ...entry, evidence: [...entry.evidence] }]))
  for (const entry of delta) {
    const existing = map.get(entry.id)
    if (!existing) {
      map.set(entry.id, entry)
      continue
    }
    const known = new Set(existing.evidence.map((item) => item.record_id))
    for (const item of entry.evidence) {
      if (!known.has(item.record_id)) existing.evidence.push(item)
    }
    existing.evidence = existing.evidence.slice(-10)
    existing.confidence = Math.max(existing.confidence, entry.confidence)
    existing.origin = existing.origin === "repeated" || entry.origin === "repeated" ? "repeated" : existing.origin
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 25)
}

function computeStats(records: MemoryRecord[]): Profile["stats"] {
  const sessions = new Set<string>()
  const hours = new Set<number>()
  let user = 0
  let assistant = 0
  let tools = 0
  for (const record of records) {
    sessions.add(record.session_id)
    if (record.kind === "message.user") user++
    if (record.kind === "message.assistant.text") assistant++
    if (record.kind === "message.assistant.tool") tools++
    const date = new Date(record.created_at)
    if (!Number.isNaN(date.getTime())) hours.add(date.getUTCHours())
  }
  return {
    records: records.length,
    user_messages: user,
    assistant_messages: assistant,
    tool_calls: tools,
    sessions: sessions.size,
    active_utc_hours: [...hours].sort((a, b) => a - b),
  }
}

function countTools(records: MemoryRecord[]): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const record of records) {
    if (record.kind !== "message.assistant.tool") continue
    const name = typeof record.payload.name === "string" ? record.payload.name : "unknown"
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
}

function countLanguages(records: MemoryRecord[]): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const record of records) {
    const serialized = JSON.stringify(record.payload)
    for (const match of serialized.matchAll(/([A-Za-z0-9_./-]+)\.([A-Za-z0-9]{1,6})\b/g)) {
      const language = EXTENSIONS[(match[2] ?? "").toLowerCase()]
      if (language) counts.set(language, (counts.get(language) ?? 0) + 1)
    }
  }
  return sortCounts(counts)
}

function extractTech(records: MemoryRecord[]): TechSignal[] {
  const counts = new Map<string, { category: string; count: number }>()
  for (const record of records) {
    const text = [
      record.kind === "message.user" ? (record.payload.text as string | undefined) : "",
      record.kind === "message.shell" ? (record.payload.command as string | undefined) : "",
      record.kind === "message.user" || record.kind === "message.assistant.text" ? JSON.stringify(record.payload) : "",
    ]
      .filter(Boolean)
      .join("\n")
    if (!text) continue
    for (const entry of TECH_DICTIONARY) {
      const matches = text.match(entry.pattern)
      if (!matches) continue
      const current = counts.get(entry.name) ?? { category: entry.category, count: 0 }
      current.count += matches.length
      counts.set(entry.name, current)
    }
  }
  return [...counts.entries()]
    .map(([name, value]) => ({ name, category: value.category, count: value.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30)
}

function mergeTech(previous: TechSignal[], delta: TechSignal[]): TechSignal[] {
  const map = new Map(previous.map((entry) => [entry.name, { ...entry }]))
  for (const entry of delta) {
    const existing = map.get(entry.name)
    if (existing) existing.count += entry.count
    else map.set(entry.name, { ...entry })
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 40)
}

function mergeCounts(
  previous: { name: string; count: number }[],
  delta: { name: string; count: number }[],
): { name: string; count: number }[] {
  const map = new Map(previous.map((entry) => [entry.name, { ...entry }]))
  for (const entry of delta) {
    const existing = map.get(entry.name)
    if (existing) existing.count += entry.count
    else map.set(entry.name, { ...entry })
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 30)
}

function topCommands(records: MemoryRecord[]): string[] {
  const counts = new Map<string, number>()
  const seen = new Set<string>()
  for (const record of records) {
    let command = ""
    if (record.kind === "message.shell") {
      command = typeof record.payload.command === "string" ? record.payload.command : ""
    } else if (record.kind === "message.assistant.tool" && record.payload.name === "shell") {
      const input = record.payload.input
      if (input && typeof input === "object" && !Array.isArray(input)) {
        const value = (input as Record<string, unknown>).command
        if (typeof value === "string") command = value
      }
    }
    command = command.trim()
    if (!command) continue
    const key = `${record.session_id}:${record.message_id ?? record.record_id}:${command}`
    if (seen.has(key)) continue
    seen.add(key)
    const summary = redactText(command.split(/\s+/).slice(0, 4).join(" "), 120)
    counts.set(summary, (counts.get(summary) ?? 0) + 1)
  }
  return sortCounts(counts)
    .slice(0, 10)
    .map((entry) => entry.name)
}

function averageUserMessageLength(records: MemoryRecord[]): number {
  let total = 0
  let count = 0
  for (const record of records) {
    if (record.kind !== "message.user") continue
    const text = typeof record.payload.text === "string" ? record.payload.text : ""
    total += text.length
    count++
  }
  return count === 0 ? 0 : Math.round(total / count)
}

function sortCounts(counts: Map<string, number>): { name: string; count: number }[] {
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
}

function cursorFor(records: MemoryRecord[], previous?: Cursor): Cursor {
  let max = previous?.last_collected_at ?? ""
  for (const record of records) {
    if (record.collected_at > max) max = record.collected_at
  }
  const ids = new Set<string>()
  for (const record of records) {
    if (record.collected_at === max) ids.add(record.record_id)
  }
  if (previous && previous.last_collected_at === max) {
    for (const id of previous.last_record_ids) ids.add(id)
  }
  return { last_collected_at: max, last_record_ids: [...ids].sort() }
}

export function comparePosition(a: Cursor | undefined, b: Cursor | undefined): number {
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  if (a.last_collected_at < b.last_collected_at) return -1
  if (a.last_collected_at > b.last_collected_at) return 1
  const left = new Set(a.last_record_ids)
  const right = new Set(b.last_record_ids)
  if (left.size === right.size && [...left].every((id) => right.has(id))) return 0
  // At the same millisecond, a cursor containing every ID of the other plus more
  // reflects a later collection pass.
  if (left.size < right.size && [...left].every((id) => right.has(id))) return -1
  if (right.size < left.size && [...right].every((id) => left.has(id))) return 1
  const leftKey = [...left].sort().join("\u0000")
  const rightKey = [...right].sort().join("\u0000")
  return leftKey < rightKey ? -1 : 1
}

/** An older analysis result must never overwrite a newer profile. */
export function shouldWriteProfile(existing: Cursor | undefined, next: Cursor): boolean {
  if (!existing) return true
  return comparePosition(existing, next) <= 0
}

function mergeRecords(previous: MemoryRecord[], fresh: MemoryRecord[]): MemoryRecord[] {
  if (previous.length === 0) return fresh
  const seen = new Set(previous.map((record) => record.record_id))
  return [...previous, ...fresh.filter((record) => !seen.has(record.record_id))]
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

async function writeSharedProposal(
  options: AnalysisOptions,
  records: MemoryRecord[],
  now: Date,
  analyzerVersion: string,
): Promise<boolean> {
  if (!options.projectID) return false
  const path = join(options.repoDir, "analysis", "projects", options.projectID, "shared-context.proposal.md")
  const existing = await readProposal(path)
  const cursor = cursorFor(records, existing?.cursor)
  if (existing && comparePosition(existing.cursor, cursor) >= 0) return false
  if (records.length === 0) return false

  const allPreferences = extractPreferences(records.filter((record) => record.kind === "message.user"))
  const stack = extractTech(records).slice(0, 10)
  const languages = countLanguages(records).slice(0, 8)
  const commands = topCommands(records).slice(0, 8)
  const stats = computeStats(records)
  const candidates = allPreferences.filter((entry) => entry.confidence < 0.75).slice(0, 8)

  const lines = [
    `# Shared context proposal: ${options.projectName ?? options.projectID}`,
    "",
    "> PROPOSAL ONLY. The analyzer never edits `shared-context.md` or `conventions.md`.",
    "> Review each statement, then copy approved items into the canonical project files.",
    "",
    `- Generated: ${now.toISOString()}`,
    `- Analyzer: ${analyzerVersion}`,
    `- Input: ${stats.records} records, ${stats.sessions} sessions, ${stats.user_messages} user messages`,
    "",
    "## Stack signals",
    ...(stack.length ? stack.map((entry) => `- ${entry.name} (${entry.category}): ${entry.count} mentions`) : ["- No strong signals yet."]),
    "",
    "## Languages and file types",
    ...(languages.length ? languages.map((entry) => `- ${entry.name}: ${entry.count}`) : ["- No file-type signals yet."]),
    "",
    "## Repeated commands",
    ...(commands.length ? commands.map((command) => `- \`${command}\``) : ["- No shell commands collected yet."]),
    "",
    "## Candidate team rules (needs review)",
    ...(candidates.length
      ? candidates.map(
          (entry) =>
            `- **${entry.statement}**\n  - Confidence: ${entry.confidence.toFixed(2)}\n  - Evidence: ${entry.evidence
              .slice(0, 3)
              .map((item) => `\`${item.record_id}\``)
              .join(", ")}`,
        )
      : ["- No candidate rules detected. Do not promote individual statements automatically."]),
    "",
    "## Review checklist",
    "- [ ] The rule is agreed by the team, not one person's one-off preference.",
    "- [ ] The evidence is current and still accurate.",
    "- [ ] The rule belongs to the project, not to one developer.",
    "- [ ] Sensitive or personal information is removed.",
    "",
    `<!-- generated_from: ${JSON.stringify(cursor)} -->`,
  ]
  await atomicWriteText(path, `${lines.join("\n")}\n`)
  return true
}

async function readProposal(path: string): Promise<{ cursor: Cursor } | null> {
  if (!existsSync(path)) return null
  const text = await readFile(path, "utf8").catch(() => "")
  const match = /<!-- generated_from: (.*?) -->/.exec(text)
  if (!match) return null
  const raw = match[1] ?? ""
  try {
    const parsed = JSON.parse(raw) as Cursor
    if (parsed && typeof parsed.last_collected_at === "string" && Array.isArray(parsed.last_record_ids)) {
      return { cursor: parsed }
    }
  } catch {
    // Older proposals stored only the timestamp.
  }
  return { cursor: { last_collected_at: raw, last_record_ids: [] } }
}

function checkpointPath(repoDir: string, developerID: string, projectID: string): string {
  return join(repoDir, "sync", "checkpoints", developerID, `${projectID}.json`)
}

function globalProfilePath(repoDir: string, developerID: string): string {
  return join(repoDir, "developers", developerID, "profile.json")
}

function detailAnalysisPath(repoDir: string, developerID: string): string {
  return join(repoDir, "analysis", "developers", developerID, "global.json")
}

function projectProfilePath(repoDir: string, projectID: string, developerID: string): string {
  return join(repoDir, "projects", projectID, "developers", developerID, "profile.json")
}

function projectAnalysisPath(repoDir: string, projectID: string, developerID: string): string {
  return join(repoDir, "analysis", "projects", projectID, "developers", `${developerID}.json`)
}

export async function readCheckpoint(path: string): Promise<Checkpoint | null> {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, "utf8")) as Checkpoint
  } catch {
    return null
  }
}

export async function readProfile(path: string): Promise<Profile | null> {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Profile
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function atomicWriteText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, text, "utf8")
  await rename(tmp, path)
}

export function analysisDue(lastAttempt: string | undefined, intervalHours: number, now = new Date()): boolean {
  if (!lastAttempt) return true
  const last = Date.parse(lastAttempt)
  if (!Number.isFinite(last)) return true
  return now.getTime() - last >= intervalHours * 3_600_000
}

export function nextAnalysisAt(lastAttempt: string | undefined, intervalHours: number): string | undefined {
  if (!lastAttempt) return nowIso()
  const last = Date.parse(lastAttempt)
  if (!Number.isFinite(last)) return nowIso()
  return new Date(last + intervalHours * 3_600_000).toISOString()
}
