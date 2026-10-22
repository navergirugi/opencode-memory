import { projectIdFor } from "./config.js"
import { nowIso, toIso } from "./ids.js"
import type { Logger } from "./logger.js"
import { redactJson, redactText } from "./redact.js"
import type { LocalQueue } from "./store.js"
import { SCHEMA_VERSION, type MemoryConfig, type MemoryRecord, type RecordKind } from "./types.js"

export interface SourceSession {
  id: string
  projectID?: string
  title?: string
  agent?: string
  model?: { providerID?: string; id?: string; variant?: string }
  outcome?: string
  time: { created: number; updated: number }
  location?: { directory?: string; projectID?: string; project?: { id?: string; canonical?: string } }
}

export interface SourceToolState {
  status?: string
  input?: unknown
  content?: unknown
  error?: unknown
  executed?: boolean
}

export interface SourceMessage {
  id: string
  type: string
  time?: { created?: number; completed?: number }
  text?: string
  description?: string
  metadata?: unknown
  files?: unknown
  agents?: unknown
  skills?: unknown
  agent?: string
  model?: unknown
  content?: unknown
  command?: string
  status?: string
  exit?: unknown
  output?: { output?: string } | string
  shellID?: string
}

export interface CollectorDeps {
  config: MemoryConfig
  queue: LocalQueue
  log: Logger
  location: { directory: string; projectID: string; canonical?: string }
  sessions: {
    list(input: { project?: string; directory?: string; limit?: number; order?: "asc" | "desc" }): Promise<{ data: SourceSession[] }>
    get(input: { sessionID: string }): Promise<SourceSession>
    context(input: { sessionID: string }): Promise<SourceMessage[]>
  }
  now?: () => Date
  isPaused?: () => boolean
}

export class Collector {
  private readonly sessionProjects = new Map<string, { projectID: string; canonical?: string; directory?: string }>()
  private readonly collecting = new Set<string>()
  private lastScanAt = 0

  constructor(private readonly deps: CollectorDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private paused(): boolean {
    return this.deps.isPaused?.() ?? this.deps.config.paused === true
  }

  projectFor(session: SourceSession): { projectId: string; canonical?: string; directory?: string } | null {
    const opencodeProjectId = session.projectID ?? session.location?.projectID ?? session.location?.project?.id
    if (!opencodeProjectId) return null
    if (!this.deps.config.collect_all_projects) {
      const expected = this.deps.location.projectID
      if (expected && opencodeProjectId !== expected) return null
    }
    const projectId = projectIdFor(this.deps.config, opencodeProjectId, session.location?.project?.canonical)
    return {
      projectId,
      canonical: session.location?.project?.canonical,
      directory: session.location?.directory,
    }
  }

  private cacheProject(session: SourceSession): { projectId: string; canonical?: string; directory?: string } | null {
    const project = this.projectFor(session)
    if (project) {
      this.sessionProjects.set(session.id, {
        projectID: project.projectId,
        canonical: project.canonical,
        directory: project.directory,
      })
    }
    return project
  }

  async ensureSession(sessionID: string): Promise<{ projectId: string; canonical?: string; directory?: string } | null> {
    const cached = this.sessionProjects.get(sessionID)
    if (cached) return { projectId: cached.projectID, canonical: cached.canonical, directory: cached.directory }
    try {
      const session = await this.deps.sessions.get({ sessionID })
      return this.cacheProject(session)
    } catch (error) {
      this.deps.log.debug("Could not read session metadata", { sessionID, error: String(error) })
      return null
    }
  }

  async collectRecent(limit = 20): Promise<{ sessions: number; records: number }> {
    if (this.paused()) return { sessions: 0, records: 0 }
    let list
    try {
      list = await this.deps.sessions.list(
        this.deps.config.collect_all_projects
          ? { limit, order: "desc" }
          : {
              project: this.deps.location.projectID,
              directory: this.deps.location.directory,
              limit,
              order: "desc",
            },
      )
    } catch (error) {
      this.deps.log.warn("Could not list sessions for memory collection", { error: String(error) })
      try {
        list = await this.deps.sessions.list({ limit, order: "desc" })
      } catch {
        return { sessions: 0, records: 0 }
      }
    }
    let sessions = 0
    let records = 0
    for (const session of list.data.slice(0, limit)) {
      const result = await this.collectSession(session.id, session)
      if (result) {
        sessions++
        records += result
      }
    }
    this.lastScanAt = this.now().getTime()
    return { sessions, records }
  }

  lastScan(): number {
    return this.lastScanAt
  }

  async collectSession(sessionID: string, known?: SourceSession): Promise<number | null> {
    if (this.paused() || this.collecting.has(sessionID)) return null
    this.collecting.add(sessionID)
    try {
      const session = known ?? (await this.deps.sessions.get({ sessionID }))
      const project = this.cacheProject(session)
      if (!project) return null
      const messages = await this.deps.sessions.context({ sessionID })
      const collectedAt = this.now().toISOString()
      const records = [
        this.sessionRecord(session, project.projectId, collectedAt),
        ...messages.flatMap((message) => this.messageRecords(session, message, project.projectId, collectedAt)),
      ]
      const added = await this.deps.queue.enqueue(records)
      if (added > 0) this.deps.log.debug("Queued session records", { sessionID, added })
      return added
    } catch (error) {
      this.deps.log.warn("Could not collect session history", { sessionID, error: String(error) })
      return null
    } finally {
      this.collecting.delete(sessionID)
    }
  }

  /** Capture the user prompt at admission, before it can be lost to compaction. */
  async collectPrompt(event: {
    sessionID: string
    messageID: string
    prompt: { text?: string; files?: unknown; agents?: unknown; skills?: unknown }
    metadata?: unknown
    delivery?: string
  }): Promise<number> {
    if (this.paused()) return 0
    const project = await this.ensureSession(event.sessionID)
    if (!project) return 0
    const created = this.now().toISOString()
    const record: MemoryRecord = {
      schema_version: SCHEMA_VERSION,
      record_id: `${event.sessionID}:${event.messageID}:user`,
      kind: "message.user",
      project_id: project.projectId,
      developer_id: this.deps.config.developer_id,
      device_id: this.deps.config.device_id,
      session_id: event.sessionID,
      message_id: event.messageID,
      event: "prompt",
      created_at: created,
      collected_at: created,
      source: "prompt-hook",
      payload: {
        text: redactText(event.prompt.text ?? "", 12_000),
        files: summarizeFiles(event.prompt.files),
        agents: summarizeNamed(event.prompt.agents),
        skills: summarizeNamed(event.prompt.skills),
        metadata: redactJson(event.metadata),
        delivery: event.delivery,
      },
    }
    const added = await this.deps.queue.enqueue([record])
    // Reconcile the rest of the session shortly after the prompt is admitted.
    void this.collectSession(event.sessionID).catch(() => undefined)
    return added
  }

  /** Capture a tool result from the official tool hook. */
  async collectTool(event: {
    sessionID: string
    messageID: string
    id: string
    tool: string
    input: unknown
    status: "completed" | "error"
    result?: unknown
    error?: unknown
  }): Promise<number> {
    if (this.paused()) return 0
    const project = await this.ensureSession(event.sessionID)
    if (!project) return 0
    const created = this.now().toISOString()
    const record: MemoryRecord = {
      schema_version: SCHEMA_VERSION,
      record_id: `${event.sessionID}:${event.messageID}:tool:${event.id}`,
      kind: "message.assistant.tool",
      project_id: project.projectId,
      developer_id: this.deps.config.developer_id,
      device_id: this.deps.config.device_id,
      session_id: event.sessionID,
      message_id: event.messageID,
      event: "tool",
      created_at: created,
      collected_at: created,
      source: "tool-hook",
      payload: toolPayload(event.tool, event.status, event.input, event.result, event.error, undefined),
    }
    return this.deps.queue.enqueue([record])
  }

  /** Capture durable events. Only events from this plugin's project are recorded. */
  async collectEvent(event: { type: string; created?: number; data?: Record<string, unknown> }): Promise<number> {
    if (this.paused()) return 0
    const data = event.data ?? {}
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID || !event.type.startsWith("session.")) return 0
    const project = await this.ensureSession(sessionID)
    if (!project) return 0
    const created = toIso(event.created)
    const records: MemoryRecord[] = []
    const base = {
      schema_version: SCHEMA_VERSION,
      project_id: project.projectId,
      developer_id: this.deps.config.developer_id,
      device_id: this.deps.config.device_id,
      session_id: sessionID,
      created_at: created,
      collected_at: this.now().toISOString(),
      source: "event" as const,
    }
    const assistantID = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
    switch (event.type) {
      case "session.created": {
        if (typeof data.projectID === "string" && data.projectID !== this.deps.location.projectID && !this.deps.config.collect_all_projects) {
          return 0
        }
        records.push({
          ...base,
          record_id: `${sessionID}:meta:created`,
          kind: "session.meta",
          event: event.type,
          payload: {
            title: typeof data.title === "string" ? redactText(data.title, 300) : undefined,
            project_id: data.projectID,
            agent: data.agent,
            model: data.model,
            parent_id: data.parentID,
          },
        })
        break
      }
      case "session.text.ended":
        if (assistantID && typeof data.text === "string") {
          records.push({
            ...base,
            record_id: `${sessionID}:${assistantID}:text:${Number(data.ordinal) || 0}`,
            kind: "message.assistant.text",
            message_id: assistantID,
            event: event.type,
            payload: { text: redactText(data.text, 12_000), ordinal: data.ordinal },
          })
        }
        break
      case "session.reasoning.ended":
        if (assistantID && typeof data.text === "string") {
          records.push({
            ...base,
            record_id: `${sessionID}:${assistantID}:reasoning:${Number(data.ordinal) || 0}`,
            kind: "message.assistant.reasoning",
            message_id: assistantID,
            event: event.type,
            payload: { text: redactText(data.text, 6_000), ordinal: data.ordinal },
          })
        }
        break
      case "session.tool.called":
      case "session.tool.success":
      case "session.tool.failed":
        // The tool event schema does not carry the tool name. The tool hook and
        // session context both provide it, so avoid writing an "unknown" record
        // that would win deduplication over the richer source.
        return 0
      case "session.shell.ended": {
        const shell = data.shell as { id?: string; command?: string; status?: string; exit?: unknown } | undefined
        if (shell) {
          const messageID = `shell:${shell.id ?? shortEventId(event)}`
          records.push({
            ...base,
            record_id: `${sessionID}:${messageID}:shell`,
            kind: "message.shell",
            message_id: messageID,
            event: event.type,
            payload: {
              command: redactText(shell.command ?? "", 2_000),
              status: shell.status,
              exit: shell.exit,
              output: redactText(extractOutput(data.output), 2_000),
            },
          })
        }
        break
      }
      case "session.compaction.ended":
        records.push({
          ...base,
          record_id: `${sessionID}:compaction:${event.created ?? 0}`,
          kind: "message.compaction",
          event: event.type,
          payload: {
            reason: data.reason,
            text: redactText(typeof data.text === "string" ? data.text : "", 8_000),
          },
        })
        break
      case "session.synthetic":
        if (typeof data.text === "string") {
          records.push({
            ...base,
            record_id: `${sessionID}:synthetic:${shortEventId(event)}`,
            kind: "message.synthetic",
            event: event.type,
            payload: { text: redactText(data.text, 6_000), description: data.description },
          })
        }
        break
      case "session.skill.activated":
        records.push({
          ...base,
          record_id: `${sessionID}:skill:${shortEventId(event)}`,
          kind: "message.skill",
          event: event.type,
          payload: { id: data.id, name: data.name, text: redactText(typeof data.text === "string" ? data.text : "", 4_000) },
        })
        break
      default:
        return 0
    }
    return this.deps.queue.enqueue(records)
  }

  private sessionRecord(session: SourceSession, projectId: string, collectedAt: string): MemoryRecord {
    return {
      schema_version: SCHEMA_VERSION,
      record_id: `${session.id}:meta:${session.time.updated}`,
      kind: "session.meta",
      project_id: projectId,
      developer_id: this.deps.config.developer_id,
      device_id: this.deps.config.device_id,
      session_id: session.id,
      event: "session.meta",
      created_at: toIso(session.time.updated),
      collected_at: collectedAt,
      source: "api",
      payload: {
        title: session.title ? redactText(session.title, 300) : undefined,
        agent: session.agent,
        model: session.model,
        outcome: session.outcome,
        created: toIso(session.time.created),
        updated: toIso(session.time.updated),
        canonical: session.location?.project?.canonical,
      },
    }
  }

  private messageRecords(session: SourceSession, message: SourceMessage, projectId: string, collectedAt: string): MemoryRecord[] {
    const created = toIso(message.time?.created ?? session.time.updated)
    const base = {
      schema_version: SCHEMA_VERSION,
      project_id: projectId,
      developer_id: this.deps.config.developer_id,
      device_id: this.deps.config.device_id,
      session_id: session.id,
      message_id: message.id,
      created_at: created,
      collected_at: collectedAt,
      source: "api" as const,
    }
    if (message.type === "user") {
      return [
        {
          ...base,
          record_id: `${session.id}:${message.id}:user`,
          kind: "message.user" as RecordKind,
          event: "message.user",
          payload: {
            text: redactText(message.text ?? "", 12_000),
            files: summarizeFiles(message.files),
            agents: summarizeNamed(message.agents),
            skills: summarizeNamed(message.skills),
            metadata: redactJson(message.metadata),
          },
        },
      ]
    }
    if (message.type === "synthetic" || message.type === "system") {
      return [
        {
          ...base,
          record_id: `${session.id}:${message.id}:${message.type}`,
          kind: message.type === "synthetic" ? ("message.synthetic" as RecordKind) : ("message.system" as RecordKind),
          event: `message.${message.type}`,
          payload: { text: redactText(message.text ?? "", 8_000), description: message.description },
        },
      ]
    }
    if (message.type === "shell") {
      return [
        {
          ...base,
          record_id: `${session.id}:${message.id}:shell`,
          kind: "message.shell" as RecordKind,
          event: "message.shell",
          payload: {
            command: redactText(message.command ?? "", 2_000),
            status: message.status,
            exit: message.exit,
            output: redactText(extractOutput(message.output), 2_000),
          },
        },
      ]
    }
    if (message.type === "compaction") {
      return [
        {
          ...base,
          record_id: `${session.id}:${message.id}:compaction`,
          kind: "message.compaction" as RecordKind,
          event: "message.compaction",
          payload: { text: redactText(extractCompactionText(message), 8_000) },
        },
      ]
    }
    if (message.type !== "assistant") return []
    const content = Array.isArray(message.content) ? message.content : []
    const records: MemoryRecord[] = []
    content.forEach((part, ordinal) => {
      if (!part || typeof part !== "object") return
      const entry = part as Record<string, unknown>
      if (entry.type === "text" && typeof entry.text === "string") {
        records.push({
          ...base,
          record_id: `${session.id}:${message.id}:text:${ordinal}`,
          kind: "message.assistant.text",
          event: "message.assistant.text",
          payload: { text: redactText(entry.text, 12_000), ordinal },
        })
      } else if (entry.type === "reasoning" && typeof entry.text === "string") {
        records.push({
          ...base,
          record_id: `${session.id}:${message.id}:reasoning:${ordinal}`,
          kind: "message.assistant.reasoning",
          event: "message.assistant.reasoning",
          payload: { text: redactText(entry.text, 6_000), ordinal },
        })
      } else if (entry.type === "tool") {
        const state = (entry.state ?? {}) as SourceToolState
        records.push({
          ...base,
          record_id: `${session.id}:${message.id}:tool:${String(entry.id ?? ordinal)}`,
          kind: "message.assistant.tool",
          event: "message.assistant.tool",
          payload: toolPayload(
            String(entry.name ?? "unknown"),
            String(state.status ?? "unknown"),
            state.input,
            state.content,
            state.error,
            entry,
          ),
        })
      }
    })
    return records
  }
}

function shortEventId(event: { created?: number; type: string }): string {
  return `${event.type}:${event.created ?? Date.now()}`
}

function toolPayload(
  name: string,
  status: string,
  input: unknown,
  content: unknown,
  error: unknown,
  raw: unknown,
): Record<string, unknown> {
  return {
    name,
    status,
    input: redactJson(input),
    output: summarizeToolOutput(content),
    error: error ? summarizeError(error) : undefined,
    executed: (raw as { executed?: boolean } | undefined)?.executed,
  }
}

function summarizeToolOutput(content: unknown): string[] {
  if (content && typeof content === "object" && !Array.isArray(content) && "content" in content) {
    return summarizeToolOutput((content as { content?: unknown }).content)
  }
  if (typeof content === "string") return [redactText(content, 1_500)]
  if (!Array.isArray(content)) return []
  const parts: string[] = []
  for (const item of content.slice(0, 5)) {
    if (!item || typeof item !== "object") continue
    const entry = item as Record<string, unknown>
    if (entry.type === "text" && typeof entry.text === "string") {
      parts.push(redactText(entry.text, 1_000))
    } else if (entry.type === "file") {
      parts.push(`[file ${typeof entry.name === "string" ? entry.name : "attachment"} ${typeof entry.mime === "string" ? entry.mime : ""}]`)
    }
  }
  return parts
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error && typeof error === "object") {
    const entry = error as Record<string, unknown>
    return {
      type: entry.type,
      message: typeof entry.message === "string" ? redactText(entry.message, 1_000) : undefined,
      status: entry.status,
    }
  }
  return { message: redactText(String(error), 1_000) }
}

function summarizeFiles(files: unknown): { name?: string; mime?: string }[] {
  if (!Array.isArray(files)) return []
  return files.slice(0, 20).map((file) => {
    if (typeof file === "string") return { name: file.split(/[\\/]/).pop()?.slice(0, 200) }
    if (file && typeof file === "object") {
      const entry = file as Record<string, unknown>
      const uri = typeof entry.uri === "string" ? entry.uri : ""
      const name =
        typeof entry.name === "string"
          ? entry.name
          : uri
            ? decodeURIComponent(uri.split("/").pop() ?? "").slice(0, 200)
            : undefined
      return { name, mime: typeof entry.mime === "string" ? entry.mime : undefined }
    }
    return {}
  })
}

function summarizeNamed(values: unknown): { id?: string; name?: string }[] {
  if (!Array.isArray(values)) return []
  return values.slice(0, 20).map((value) => {
    if (typeof value === "string") return { name: value.slice(0, 120) }
    if (value && typeof value === "object") {
      const entry = value as Record<string, unknown>
      return {
        id: typeof entry.id === "string" ? entry.id.slice(0, 120) : undefined,
        name: typeof entry.name === "string" ? entry.name.slice(0, 120) : undefined,
      }
    }
    return {}
  })
}

function extractOutput(output: unknown): string {
  if (typeof output === "string") return output
  if (output && typeof output === "object" && typeof (output as { output?: unknown }).output === "string") {
    return (output as { output: string }).output
  }
  return ""
}

function extractCompactionText(message: SourceMessage): string {
  if (typeof message.text === "string") return message.text
  const content = message.content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n")
  }
  return ""
}

export function makeCollectedAt(): string {
  return nowIso()
}
