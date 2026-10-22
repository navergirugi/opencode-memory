import { existsSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { DoctorReport, MemoryConfig, StatusReport } from "./types.js"
import { nextAnalysisAt } from "./analyze.js"
import { pendingGitWork, isGitRepository, remoteUrl, resolveGitAuth, pushDryRun, sanitizeGitError } from "./git.js"
import { redactUrl } from "./redact.js"
import type { LocalQueue } from "./store.js"
import type { Logger } from "./logger.js"

export interface RuntimeState {
  last_sync_at?: string
  last_sync_error?: string
  last_sync_conflict?: boolean
  last_analysis_at?: string
  last_analysis_attempt_at?: string
  last_analysis_error?: string
  last_deep_analysis_at?: string
  last_scan_at?: string
  collected_sessions: number
  queued_records: number
}

export function emptyState(): RuntimeState {
  return { collected_sessions: 0, queued_records: 0 }
}

function statePath(dataDir: string): string {
  return join(dataDir, "state", "runtime.json")
}

export async function readRuntimeState(dataDir: string): Promise<RuntimeState> {
  const path = statePath(dataDir)
  if (!existsSync(path)) return emptyState()
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<RuntimeState>
    return { ...emptyState(), ...parsed }
  } catch {
    return emptyState()
  }
}

export async function writeRuntimeState(dataDir: string, state: RuntimeState): Promise<void> {
  const path = statePath(dataDir)
  await mkdir(join(dataDir, "state"), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

export interface StatusDeps {
  config: MemoryConfig | null
  configError?: string
  dataDir: string
  repoDir: string
  location: { projectID: string; directory: string; canonical?: string; projectName?: string }
  projectID?: string
  queue: LocalQueue
  log: Logger
}

export async function buildStatus(deps: StatusDeps): Promise<StatusReport> {
  const state = await readRuntimeState(deps.dataDir)
  const config = deps.config
  const report: StatusReport = {
    configured: Boolean(config?.setup_completed_at),
    paused: config?.paused === true,
    developer_id: config?.developer_id,
    developer_name: config?.developer_name,
    device_id: config?.device_id,
    device_name: config?.device_name,
    project_id: deps.projectID,
    opencode_project_id: deps.location.projectID,
    repository: config ? redactUrl(config.repo_url) : undefined,
    data_dir: deps.dataDir,
    setup_completed_at: config?.setup_completed_at,
    last_sync_at: state.last_sync_at,
    last_sync_error: state.last_sync_error ?? deps.configError,
    pending_records: 0,
    pending_commits: 0,
    last_analysis_at: state.last_analysis_at,
    last_analysis_error: state.last_analysis_error,
    next_analysis_at: config ? nextAnalysisAt(state.last_analysis_at, config.analysis_interval_hours) : undefined,
    collected_sessions: state.collected_sessions,
    restrictions: [
      "The OpenCode session API returns only messages after the latest compaction; prompts and tool results are captured live to reduce this gap.",
      "GitHub credentials are never stored in the memory repository. Background errors are reported here and in the local log.",
    ],
  }
  try {
    report.pending_records = await deps.queue.count()
  } catch {
    report.pending_records = state.queued_records
  }
  if (config && isGitRepository(deps.repoDir)) {
    try {
      const pending = await pendingGitWork(deps.repoDir)
      report.pending_commits = pending.commits + pending.dirty
    } catch {
      // Git state is diagnostic only.
    }
  }
  return report
}

export function renderStatus(report: StatusReport): string {
  const lines = [
    "OpenCode Memory status",
    `- Setup: ${report.configured ? "complete" : "not configured (run the memory tool with action=setup, or /memory-setup)"}`,
    `- Developer: ${report.developer_id ?? "unset"}${report.developer_name ? ` (${report.developer_name})` : ""}`,
    `- Device: ${report.device_id ?? "unset"}${report.device_name ? ` (${report.device_name})` : ""}`,
    `- Project: ${report.project_id ?? "unmapped"} (OpenCode ${report.opencode_project_id ?? "unknown"})`,
    `- Repository: ${report.repository ?? "unset"}`,
    `- Data directory: ${report.data_dir}`,
    `- Last successful sync: ${report.last_sync_at ?? "never"}`,
    `- Pending local records: ${report.pending_records} (unpushed commits/changes: ${report.pending_commits})`,
    `- Last analysis: ${report.last_analysis_at ?? "never"}`,
    `- Next analysis: ${report.next_analysis_at ?? "not scheduled"}`,
    `- Collected sessions: ${report.collected_sessions}`,
    report.paused ? "- Collection is paused." : "- Collection is active.",
  ]
  if (report.last_sync_error) lines.push(`- Sync error: ${report.last_sync_error}`)
  if (report.last_analysis_error) lines.push(`- Analysis error: ${report.last_analysis_error}`)
  lines.push("", "Known limitations:")
  for (const restriction of report.restrictions) lines.push(`- ${restriction}`)
  return lines.join("\n")
}

export interface DoctorDeps {
  config: MemoryConfig | null
  configError?: string
  dataDir: string
  repoDir: string
  log: Logger
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorReport["checks"] = []
  checks.push({
    name: "configuration",
    ok: Boolean(deps.config?.setup_completed_at),
    detail: deps.config?.setup_completed_at
      ? `Configured for ${deps.config.developer_id} / ${deps.config.device_id}`
      : deps.configError ?? "Run setup first.",
  })

  if (!deps.config) return { ok: false, checks }

  checks.push({
    name: "data-directory",
    ok: existsSync(deps.dataDir),
    detail: deps.dataDir,
  })

  const repoOk = isGitRepository(deps.repoDir)
  checks.push({
    name: "local-repository",
    ok: repoOk,
    detail: repoOk ? deps.repoDir : "The private memory repository is not cloned yet.",
  })

  if (repoOk) {
    const remote = await remoteUrl(deps.repoDir)
    checks.push({
      name: "origin",
      ok: remote === deps.config.repo_url,
      detail: remote ? redactUrl(remote) : "origin is missing",
    })
    try {
      const auth = await resolveGitAuth(deps.config.repo_url)
      // Ambient credential helpers and SSH agents are valid; read/write checks below decide access.
      checks.push({ name: "authentication", ok: true, detail: auth.description })
      const read = await import("./git.js").then((module) => module.runGit(["ls-remote", "--heads", "origin"], { cwd: deps.repoDir, env: auth.env, timeoutMs: 30_000 }))
      checks.push({
        name: "read-access",
        ok: read.code === 0,
        detail: read.code === 0 ? "Remote is readable." : "Could not read the remote. Check credentials or network.",
      })
      const write = await pushDryRun(deps.repoDir, auth)
      checks.push({ name: "write-access", ok: write.ok, detail: write.detail })
    } catch (error) {
      checks.push({ name: "git", ok: false, detail: sanitizeGitError(error) })
    }
  }

  const queueDir = join(deps.dataDir, "queue")
  checks.push({
    name: "local-queue",
    ok: existsSync(queueDir) || existsSync(deps.dataDir),
    detail: queueDir,
  })

  return { ok: checks.every((check) => check.ok), checks }
}

export function renderDoctor(report: DoctorReport): string {
  return [
    `OpenCode Memory doctor: ${report.ok ? "OK" : "problems found"}`,
    ...report.checks.map((check) => `- [${check.ok ? "ok" : "fail"}] ${check.name}: ${check.detail}`),
  ].join("\n")
}
