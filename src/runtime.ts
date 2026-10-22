import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { buildStatus, renderDoctor, renderStatus, readRuntimeState, runDoctor, writeRuntimeState, type RuntimeState } from "./status.js"
import { Collector, type SourceSession } from "./collector.js"
import { buildContextText } from "./context.js"
import { ConfigError, loadConfig, projectIdFor, resolveDataDir, saveConfig } from "./config.js"
import { assertMemoryId } from "./ids.js"
import { createLogger, type Logger } from "./logger.js"
import { LocalQueue, RecordStore } from "./store.js"
import {
  cloneOrInit,
  commitAll,
  isGitRepository,
  resolveGitAuth,
  sanitizeGitError,
  syncRepository,
  withRepoLock,
  writeRepoScaffold,
  GitConflictError,
} from "./git.js"
import { analysisDue, nextAnalysisAt, runAnalysis, StaleCheckpointError } from "./analyze.js"
import { performSetup, setupSummary, setupUsage } from "./setup.js"
import type { MemoryConfig, SetupInput, StatusReport, SyncResult } from "./types.js"

type Ctx = Plugin.Context

const DEFAULT_SCAN_MS = 60_000
const DEFAULT_ANALYSIS_CHECK_MS = 15 * 60_000

export class MemoryRuntime {
  readonly dataDir: string
  readonly repoDir: string
  readonly log: Logger
  private ctx: Ctx
  private config: MemoryConfig | null = null
  private configError?: string
  private queue: LocalQueue
  private store: RecordStore
  private collector: Collector | null = null
  private state: RuntimeState
  private timers: NodeJS.Timeout[] = []
  private eventAbort: AbortController | null = null
  private started = false
  private stopping = false
  private syncInFlight: Promise<SyncResult> | null = null
  private analysisInFlight: Promise<string> | null = null
  private bootstrapInFlight: Promise<void> | null = null
  private contextCache = new Map<string, { at: number; text: string }>()
  private sessionProjectCache = new Map<string, string>()

  constructor(ctx: Ctx, options: Record<string, unknown> = {}) {
    this.ctx = ctx
    this.dataDir = resolveDataDir(options)
    this.repoDir = join(this.dataDir, "repo")
    this.log = createLogger(this.dataDir)
    this.queue = new LocalQueue(this.dataDir, this.log)
    this.store = new RecordStore(this.repoDir, this.log)
    this.state = { collected_sessions: 0, queued_records: 0 }
  }

  get currentConfig(): MemoryConfig | null {
    return this.config
  }

  get location(): { projectID: string; directory: string; canonical?: string; projectName?: string } {
    return {
      projectID: this.ctx.location.project.id,
      directory: this.ctx.location.directory,
      canonical: this.ctx.location.project.canonical,
      projectName: this.ctx.location.project.canonical?.split("/").filter(Boolean).pop(),
    }
  }

  projectId(): string | undefined {
    if (!this.config) return undefined
    return projectIdFor(this.config, this.location.projectID, this.location.canonical)
  }

  async init(options: Record<string, unknown> = {}): Promise<void> {
    this.state = await readRuntimeState(this.dataDir)
    const loaded = loadConfig(this.dataDir, options)
    this.configError = loaded.error
    const configured = loaded.config?.setup_completed_at ? loaded.config : null
    if (configured) {
      this.applyConfig(configured)
      return
    }
    this.log.info("OpenCode Memory is not configured", { error: loaded.error })
    if (options.autoSetup === true && typeof options.repoURL === "string" && typeof options.developerID === "string") {
      void this.autoSetup(options)
    }
  }

  /** Wait for startup work (repository restore, queue flush, first sync) to finish. */
  async ready(): Promise<void> {
    if (this.bootstrapInFlight) await this.bootstrapInFlight
  }

  /** Collect the most recent sessions now. Used by tests and diagnostics. */
  async collectNow(): Promise<void> {
    await this.collectTick()
  }

  private async autoSetup(options: Record<string, unknown>): Promise<void> {
    try {
      const result = await performSetup(
        {
          repoURL: String(options.repoURL),
          developerID: String(options.developerID),
          developerName: typeof options.developerName === "string" ? options.developerName : undefined,
          deviceName: typeof options.deviceName === "string" ? options.deviceName : undefined,
          projectID: typeof options.projectID === "string" ? options.projectID : undefined,
        },
        { dataDir: this.dataDir, repoDir: this.repoDir, log: this.log, location: this.location, options },
      )
      this.applyConfig(result.config)
    } catch (error) {
      this.configError = error instanceof Error ? error.message : String(error)
      this.log.error("Automatic setup failed", { error: this.configError })
    }
  }

  private applyConfig(config: MemoryConfig): void {
    this.config = config
    this.configError = undefined
    this.queue = new LocalQueue(this.dataDir, this.log)
    this.store = new RecordStore(this.repoDir, this.log)
    this.collector = new Collector({
      config,
      queue: this.queue,
      log: this.log,
      location: {
        directory: this.location.directory,
        projectID: this.location.projectID,
        canonical: this.location.canonical,
      },
      sessions: this.ctx.session as unknown as ConstructorParameters<typeof Collector>[0]["sessions"],
      isPaused: () => this.config?.paused === true,
    })
    this.contextCache.clear()
    this.sessionProjectCache.clear()
    if (!this.started) {
      this.started = true
      this.startTimers()
      void this.subscribeEvents()
    }
    void this.bootstrap()
  }

  private startTimers(): void {
    const scanMs = Math.max(15, this.config?.scan_interval_seconds ?? 60) * 1_000
    const syncMs = Math.max(30, this.config?.sync_interval_seconds ?? 300) * 1_000
    this.timers.push(
      setInterval(() => {
        void this.collectTick().catch((error) => this.log.warn("Collection tick failed", { error: String(error) }))
      }, scanMs),
    )
    this.timers.push(
      setInterval(() => {
        void this.sync("scheduled").catch((error) => this.recordSyncError(error))
      }, syncMs),
    )
    this.timers.push(
      setInterval(() => {
        void this.analysisTick().catch((error) => this.log.warn("Analysis tick failed", { error: String(error) }))
      }, DEFAULT_ANALYSIS_CHECK_MS),
    )
  }

  private analysisRetryDue(): boolean {
    if (!this.config) return false
    const attempt = this.state.last_analysis_attempt_at ? Date.parse(this.state.last_analysis_attempt_at) : 0
    return !Number.isFinite(attempt) || Date.now() - attempt >= DEFAULT_ANALYSIS_CHECK_MS
  }

  private async subscribeEvents(): Promise<void> {
    if (!this.ctx.event?.subscribe) return
    if (this.stopping) return
    this.eventAbort = new AbortController()
    let inFlight = 0
    try {
      for await (const event of this.ctx.event.subscribe({ signal: this.eventAbort.signal })) {
        if (!this.config || this.config.paused || !this.collector) continue
        if (!event || typeof event !== "object" || !("type" in event)) continue
        if (inFlight >= 16) {
          this.log.warn("Dropped an event because memory collection is behind; the next poll will reconcile session context")
          continue
        }
        inFlight++
        void this.collector
          .collectEvent(event as { type: string; created?: number; data?: Record<string, unknown> })
          .catch((error) => this.log.debug("Event capture failed", { type: (event as { type?: string }).type, error: String(error) }))
          .finally(() => {
            inFlight--
          })
      }
    } catch (error) {
      if (!this.stopping) this.log.warn("Event subscription ended", { error: String(error) })
    }
  }

  private async bootstrap(): Promise<void> {    if (this.bootstrapInFlight) return this.bootstrapInFlight
    this.bootstrapInFlight = (async () => {
      try {
        await this.ensureRepository()
        await this.flushQueue()
        await this.sync("startup")
        await this.collectTick()
        await this.analysisTick()
      } catch (error) {
        this.log.warn("Memory startup sync failed; OpenCode continues normally", { error: sanitizeGitError(error) })
      } finally {
        this.bootstrapInFlight = null
      }
    })()
    return this.bootstrapInFlight
  }

  private async ensureRepository(): Promise<void> {
    if (!this.config) throw new Error("OpenCode Memory is not configured.")
    if (isGitRepository(this.repoDir)) return
    const auth = await resolveGitAuth(this.config.repo_url)
    const cloned = await cloneOrInit({ repoDir: this.repoDir, repoUrl: this.config.repo_url, auth, log: this.log })
    if (cloned.initialized) {
      await writeRepoScaffold(this.repoDir, {
        developerId: this.config.developer_id,
        developerName: this.config.developer_name,
        deviceId: this.config.device_id,
        deviceName: this.config.device_name,
        projectId: this.projectId(),
        opencodeProjectId: this.location.projectID,
        projectName: this.location.projectName,
        canonicalHint: this.location.canonical,
        repoUrl: this.config.repo_url,
      })
      await commitAll(this.repoDir, "memory: initialize repository")
    }
    this.log.info("Restored the private memory repository")
  }

  private async flushQueue(): Promise<{ records: number; errors: string[] }> {
    if (!this.config) return { records: 0, errors: [] }
    try {
      const result = await this.queue.drain(this.store)
      if (result.records > 0) this.log.debug("Flushed queued records", { records: result.records })
      return { records: result.records, errors: result.errors }
    } catch (error) {
      return { records: 0, errors: [String(error)] }
    }
  }

  private async collectTick(): Promise<void> {
    if (!this.config || !this.collector || this.config.paused) return
    await this.ensureRepository().catch((error) => this.log.debug("Repository unavailable during collection", { error: String(error) }))
    const result = await this.collector.collectRecent(20)
    if (result.records > 0) {
      this.state.collected_sessions += result.sessions
      await this.flushQueue()
      await writeRuntimeState(this.dataDir, this.state)
    }
  }

  async sync(reason = "manual"): Promise<SyncResult> {
    if (this.syncInFlight) return this.syncInFlight
    this.syncInFlight = this.runSync(reason).finally(() => {
      this.syncInFlight = null
    })
    return this.syncInFlight
  }

  private async runSync(reason: string): Promise<SyncResult> {
    const result: SyncResult = { attempted: false, pushed: false, commits: 0, pendingRecords: 0 }
    if (!this.config) {
      result.error = "OpenCode Memory is not configured."
      return result
    }
    result.attempted = true
    try {
      await withRepoLock(this.dataDir, "sync", async () => {
        await this.ensureRepository()
        await this.flushQueue()
        const committed = await commitAll(this.repoDir, `memory: sync ${this.config!.device_id} ${new Date().toISOString()}`)
        result.commits = committed ? 1 : 0
        const auth = await resolveGitAuth(this.config!.repo_url)
        await syncRepository({ repoDir: this.repoDir, dataDir: this.dataDir, auth, log: this.log })
        result.pushed = true
        this.state.last_sync_at = new Date().toISOString()
        this.state.last_sync_error = undefined
        this.state.last_sync_conflict = false
        await writeRuntimeState(this.dataDir, this.state)
        this.log.debug("Sync completed", { reason })
      })
    } catch (error) {
      const message = error instanceof GitConflictError ? error.message : sanitizeGitError(error)
      this.state.last_sync_error = message
      this.state.last_sync_conflict = error instanceof GitConflictError
      await writeRuntimeState(this.dataDir, this.state).catch(() => undefined)
      result.error = message
      result.conflict = error instanceof GitConflictError
      this.log.warn("Sync failed; records remain queued locally", { error: message })
    }
    result.pendingRecords = await this.queue.count().catch(() => 0)
    return result
  }

  private recordSyncError(error: unknown): void {
    this.state.last_sync_error = sanitizeGitError(error)
    void writeRuntimeState(this.dataDir, this.state).catch(() => undefined)
  }

  async analyze(force = false): Promise<string> {
    if (this.analysisInFlight) return this.analysisInFlight
    this.analysisInFlight = this.runAnalysis(force).finally(() => {
      this.analysisInFlight = null
    })
    return this.analysisInFlight
  }

  private async runAnalysis(force: boolean): Promise<string> {
    if (!this.config) return "OpenCode Memory is not configured. Run setup first."
    const projectId = this.projectId()
    const sync = await this.sync("pre-analysis")
    if (sync.error) {
      return `Analysis skipped because the memory repository could not be synchronized.\n${sync.error}\nNew records remain queued locally and analysis will retry.`
    }
    if (!force && !analysisDue(this.state.last_analysis_at, this.config.analysis_interval_hours)) {
      return `Analysis is not due yet. Next run: ${nextAnalysisAt(this.state.last_analysis_at, this.config.analysis_interval_hours)}.`
    }
    this.state.last_analysis_attempt_at = new Date().toISOString()
    await writeRuntimeState(this.dataDir, this.state).catch(() => undefined)
    try {
      const result = await runAnalysis({
        repoDir: this.repoDir,
        store: this.store,
        log: this.log,
        developerID: this.config.developer_id,
        deviceID: this.config.device_id,
        projectID: projectId,
        projectName: this.location.projectName,
        force,
      })
      const now = new Date().toISOString()
      this.state.last_analysis_at = now
      this.state.last_analysis_error = undefined
      await writeRuntimeState(this.dataDir, this.state)
      await commitAll(this.repoDir, `memory: analysis ${this.config.developer_id} ${now}`)
      const pushed = await this.sync("post-analysis")
      const summary = result.ran
        ? `Analysis complete: ${result.profiles_written} profile file(s) updated.`
        : `Analysis checked; no new records to process (${result.reason}).`
      return pushed.error ? `${summary}\nSync after analysis failed: ${pushed.error}` : summary
    } catch (error) {
      const message =
        error instanceof StaleCheckpointError
          ? `Another device advanced the analysis checkpoint. Nothing was overwritten; retry after the next sync.`
          : error instanceof Error
            ? error.message
            : String(error)
      this.state.last_analysis_error = message
      await writeRuntimeState(this.dataDir, this.state).catch(() => undefined)
      this.log.warn("Analysis failed", { error: message })
      return `Analysis failed: ${message}`
    }
  }

  private async analysisTick(): Promise<void> {
    if (!this.config || this.config.paused) return
    if (!analysisDue(this.state.last_analysis_at, this.config.analysis_interval_hours)) return
    if (!this.analysisRetryDue()) return
    await this.analyze(false)
  }

  async status(): Promise<StatusReport> {
    return buildStatus({
      config: this.config,
      configError: this.configError,
      dataDir: this.dataDir,
      repoDir: this.repoDir,
      location: this.location,
      projectID: this.projectId(),
      queue: this.queue,
      log: this.log,
    })
  }

  async doctor(): Promise<string> {
    const report = await runDoctor({
      config: this.config,
      configError: this.configError,
      dataDir: this.dataDir,
      repoDir: this.repoDir,
      log: this.log,
    })
    return renderDoctor(report)
  }

  async setup(input: SetupInput): Promise<string> {
    try {
      const existing = this.config
      if (existing && existing.developer_id !== input.developerID && !input.opencodeProjectID) {
        // Reconfiguring with a different developer is allowed, but the device stays local.
      }
      const result = await performSetup(input, {
        dataDir: this.dataDir,
        repoDir: this.repoDir,
        log: this.log,
        location: this.location,
        options: {},
      })
      this.applyConfig(result.config)
      return setupSummary(result)
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : sanitizeGitError(error)
      this.configError = message
      this.log.error("Setup failed", { error: message })
      return `Setup failed: ${message}\n\n${setupUsage()}`
    }
  }

  async setPaused(paused: boolean): Promise<string> {
    if (!this.config) return "OpenCode Memory is not configured."
    this.config = { ...this.config, paused }
    saveConfig(this.dataDir, this.config)
    return paused ? "Memory collection is paused. Queued records will sync after resume." : "Memory collection resumed."
  }

  async onPrompt(event: any): Promise<void> {
    if (!this.config || !this.collector || this.config.paused) return
    await this.collector.collectPrompt(event).catch((error) => this.log.debug("Prompt capture failed", { error: String(error) }))
  }

  async onTool(event: any): Promise<void> {
    if (!this.config || !this.collector || this.config.paused) return
    if (event?.status !== "completed" && event?.status !== "error") return
    await this.collector
      .collectTool({
        sessionID: String(event.sessionID),
        messageID: String(event.messageID),
        id: String(event.id),
        tool: String(event.tool),
        input: event.input,
        status: event.status,
        result: event.result,
        error: event.error,
      })
      .catch((error) => this.log.debug("Tool capture failed", { error: String(error) }))
  }

  /** Add project-aware context to the outgoing model request. Never throws. */
  async applyContext(event: any): Promise<void> {
    if (!this.config || this.config.context_max_chars <= 0) return
    try {
      const sessionID = String(event?.sessionID ?? "")
      if (!sessionID) return
      let projectID = this.sessionProjectCache.get(sessionID)
      if (!projectID) {
        const session = (await this.ctx.session.get({ sessionID })) as unknown as SourceSession
        if (session.projectID && session.projectID !== this.location.projectID && !this.config.collect_all_projects) {
          this.sessionProjectCache.set(sessionID, "skip")
          return
        }
        projectID = projectIdFor(this.config, session.projectID ?? this.location.projectID, session.location?.project?.canonical)
        this.sessionProjectCache.set(sessionID, projectID)
      }
      if (projectID === "skip") return

      const cacheKey = projectID
      const cached = this.contextCache.get(cacheKey)
      const now = Date.now()
      let text = cached && now - cached.at < 30_000 ? cached.text : ""
      if (!text) {
        text = await buildContextText({
          repoDir: this.repoDir,
          developerID: this.config.developer_id,
          projectID,
          projectName: this.location.projectName,
          maxChars: this.config.context_max_chars,
        })
        this.contextCache.set(cacheKey, { at: now, text })
      }
      if (!text) return
      const system = Array.isArray(event.system) ? event.system : []
      const already = system.some(
        (part: { type?: string; text?: string }) =>
          part?.type === "text" && typeof part.text === "string" && part.text.includes("<!-- opencode-memory:context:v1 -->"),
      )
      if (!already) system.push({ type: "text", text })
      event.system = system
    } catch (error) {
      this.log.debug("Context injection skipped", { error: String(error) })
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    this.eventAbort?.abort()
    this.eventAbort = null
    await this.flushQueue().catch(() => undefined)
    await writeRuntimeState(this.dataDir, this.state).catch(() => undefined)
  }

  async handleTool(input: Record<string, unknown>): Promise<string> {
    const action = String(input.action ?? "status")
    try {
      switch (action) {
        case "status": {
          const report = await this.status()
          return renderStatusWithContext(report)
        }
        case "doctor":
          return await this.doctor()
        case "setup": {
          const repoURL = input.repo_url ?? input.repoURL
          const developerID = input.developer_id ?? input.developerID
          if (typeof repoURL !== "string" || typeof developerID !== "string") {
            return setupUsage()
          }
          return await this.setup({
            repoURL,
            developerID,
            developerName: typeof input.developer_name === "string" ? input.developer_name : undefined,
            deviceName: typeof input.device_name === "string" ? input.device_name : undefined,
            projectID: typeof input.project_id === "string" ? assertMemoryId("project_id", input.project_id) : undefined,
            opencodeProjectID: this.location.projectID,
          })
        }
        case "sync": {
          if (!this.config) return "OpenCode Memory is not configured. Run setup first."
          const result = await this.sync("manual")
          if (result.error) {
            return `Sync failed. New records remain in the local queue and will be retried.\n${result.error}\nPending local records: ${result.pendingRecords}`
          }
          return `Sync complete (${result.pushed ? "pushed" : "no changes"}). Pending local records: ${result.pendingRecords}`
        }
        case "analyze": {
          if (!this.config) return "OpenCode Memory is not configured. Run setup first."
          return await this.analyze(true)
        }
        case "pause":
          return await this.setPaused(true)
        case "resume":
          return await this.setPaused(false)
        case "help":
          return helpText()
        default:
          return `Unknown action "${action}".\n\n${helpText()}`
      }
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : error instanceof Error ? error.message : String(error)
      this.log.error("Memory tool action failed", { action, error: message })
      return `OpenCode Memory could not complete "${action}": ${message}\nOpenCode itself can continue normally; run action=status or action=doctor for diagnostics.`
    }
  }
}

export function renderStatusWithContext(report: StatusReport): string {
  const lines = [renderStatus(report)]
  if (!report.configured) lines.push("", "Next step: run setup with the private GitHub repository URL and your developer ID.")
  return lines.join("\n")
}

export function helpText(): string {
  return [
    "OpenCode Memory actions:",
    "- status: setup state, IDs, sync/queue/analysis state",
    "- setup: configure the private GitHub repository (repo_url, developer_id, optional names)",
    "- doctor: verify repository read/write access and local state",
    "- sync: flush the local queue, rebase, and push (never force-pushes)",
    "- analyze: run the incremental analyzer now",
    "- pause / resume: stop or restart collection",
    "",
    "Configuration is stored outside the repository; GitHub credentials are read from your Git credential helper, an environment token, or `gh auth token`.",
  ].join("\n")
}
