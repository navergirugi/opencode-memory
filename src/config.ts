import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { assertMemoryId, newDeviceId, normalizeProjectId, nowIso } from "./ids.js"
import { SCHEMA_VERSION, type MemoryConfig } from "./types.js"

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

export function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const explicit = env.OPENCODE_MEMORY_DATA_DIR
  if (explicit) return resolve(expandHome(explicit))
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, "opencode-memory")
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "opencode-memory")
  if (platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "opencode-memory")
  return join(homedir(), ".local", "share", "opencode-memory")
}

export function configPath(dataDir: string): string {
  return join(dataDir, "config.json")
}

export function resolveDataDir(options: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): string {
  const optionDir = options.dataDir ?? options.data_dir
  if (typeof optionDir === "string" && optionDir.trim()) return resolve(expandHome(optionDir.trim()))
  return defaultDataDir(env)
}

/** Validate and normalize a GitHub repository URL. Embedded credentials are rejected. */
export function validateRepoUrl(input: string, options: { allowLocal?: boolean } = {}): string {
  const url = input.trim()
  if (!url) throw new ConfigError("A private GitHub repository URL is required.")
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@/i.test(url)) {
    throw new ConfigError("Do not embed credentials in the repository URL. Use a Git credential helper or a token environment variable.")
  }
  if (/\s/.test(url)) throw new ConfigError("The repository URL must not contain whitespace.")

  const allowLocal = options.allowLocal === true || process.env.OPENCODE_MEMORY_ALLOW_LOCAL_REPOS === "1"
  if (allowLocal) {
    if (url.startsWith("file://")) return url
    if (isAbsolute(expandHome(url))) return `file://${resolve(expandHome(url))}`
  }

  const https = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url)
  if (https) return `https://github.com/${https[1]}/${https[2]}.git`

  const scp = /^(?:git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url)
  if (scp) return `git@github.com:${scp[1]}/${scp[2]}.git`

  const ssh = /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url)
  if (ssh) return `ssh://git@github.com/${ssh[1]}/${ssh[2]}.git`

  throw new ConfigError(
    "Repository URL must point to github.com using HTTPS (https://github.com/owner/repo.git) or SSH (git@github.com:owner/repo.git).",
  )
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

export function normalizeConfig(
  raw: Record<string, unknown>,
  options: { dataDir: string; createDeviceId?: boolean; allowLocalRepo?: boolean },
): MemoryConfig {
  const repoUrl = typeof raw.repo_url === "string" ? raw.repo_url : typeof raw.repoURL === "string" ? raw.repoURL : ""
  const developerId = typeof raw.developer_id === "string" ? raw.developer_id : typeof raw.developerID === "string" ? raw.developerID : ""
  if (!developerId) throw new ConfigError("developer_id is required.")
  const developer_id = assertMemoryId("developer_id", developerId)

  const deviceRaw = typeof raw.device_id === "string" ? raw.device_id : typeof raw.deviceID === "string" ? raw.deviceID : ""
  const device_id = deviceRaw ? assertMemoryId("device_id", deviceRaw) : options.createDeviceId === false ? "" : newDeviceId()
  if (!device_id) throw new ConfigError("device_id is required.")

  const projectIds: Record<string, string> = {}
  const projectRaw = raw.project_ids
  if (projectRaw && typeof projectRaw === "object" && !Array.isArray(projectRaw)) {
    for (const [key, value] of Object.entries(projectRaw as Record<string, unknown>)) {
      if (typeof value !== "string" || !key.trim()) continue
      projectIds[key] = assertMemoryId("project_id", value)
    }
  }
  const defaultProject = typeof raw.project_id === "string" ? raw.project_id : typeof raw.projectID === "string" ? raw.projectID : ""
  if (defaultProject) {
    const opencodeId =
      typeof raw.opencode_project_id === "string"
        ? raw.opencode_project_id
        : typeof raw.opencodeProjectID === "string"
          ? raw.opencodeProjectID
          : "default"
    projectIds[opencodeId] = assertMemoryId("project_id", defaultProject)
  }

  const config: MemoryConfig = {
    schema_version: SCHEMA_VERSION,
    repo_url: validateRepoUrl(repoUrl, { allowLocal: options.allowLocalRepo }),
    developer_id,
    developer_name: typeof raw.developer_name === "string" ? raw.developer_name.slice(0, 120) : undefined,
    device_id,
    device_name: typeof raw.device_name === "string" ? raw.device_name.slice(0, 120) : undefined,
    project_ids: projectIds,
    sync_interval_seconds: numberInRange(raw.sync_interval_seconds, 300, 30, 86_400),
    scan_interval_seconds: numberInRange(raw.scan_interval_seconds, 60, 15, 3_600),
    analysis_interval_hours: numberInRange(raw.analysis_interval_hours, 24, 1, 24 * 30),
    context_max_chars: numberInRange(raw.context_max_chars, 4_000, 0, 20_000),
    setup_completed_at: typeof raw.setup_completed_at === "string" ? raw.setup_completed_at : undefined,
    paused: raw.paused === true,
    collect_all_projects: raw.collect_all_projects === true,
  }
  return config
}

export interface LoadedConfig {
  config: MemoryConfig | null
  error?: string
  raw?: Record<string, unknown>
}

export function loadConfig(dataDir: string, options: Record<string, unknown> = {}): LoadedConfig {
  const path = configPath(dataDir)
  if (!existsSync(path)) {
    const repoUrl = options.repoURL ?? options.repo_url
    const developerId = options.developerID ?? options.developer_id
    if (typeof repoUrl === "string" && typeof developerId === "string") {
      try {
        return {
          config: normalizeConfig(
            {
              ...options,
              repo_url: repoUrl,
              developer_id: developerId,
              device_id: options.deviceID ?? options.device_id,
              device_name: options.deviceName ?? options.device_name,
              project_id: options.projectID ?? options.project_id,
            },
            { dataDir },
          ),
        }
      } catch (error) {
        return { config: null, error: error instanceof Error ? error.message : String(error) }
      }
    }
    return { config: null }
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    const merged: Record<string, unknown> = { ...raw }
    for (const key of [
      "sync_interval_seconds",
      "scan_interval_seconds",
      "analysis_interval_hours",
      "context_max_chars",
      "paused",
      "collect_all_projects",
    ]) {
      const optionKey = key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())
      if (options[key] !== undefined) merged[key] = options[key]
      else if (options[optionKey] !== undefined) merged[key] = options[optionKey]
    }
    const config = normalizeConfig(merged, {
      dataDir,
      createDeviceId: true,
      allowLocalRepo: options.allowLocalRepo === true || options.allow_local_repos === true,
    })
    if (!config.device_id) throw new ConfigError("device_id is missing from the stored configuration.")
    return { config, raw }
  } catch (error) {
    return { config: null, error: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function saveConfig(dataDir: string, config: MemoryConfig): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const path = configPath(dataDir)
  const tmp = `${path}.${process.pid}.tmp`
  const body = `${JSON.stringify(config, null, 2)}\n`
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // chmod is best-effort on filesystems that do not support it.
  }
  renameSync(tmp, path)
}

export function createConfigFromSetup(input: {
  repoUrl: string
  developerId: string
  developerName?: string
  deviceId: string
  deviceName?: string
  opencodeProjectId?: string
  projectId?: string
  options?: Record<string, unknown>
  allowLocalRepo?: boolean
}): MemoryConfig {
  const project_ids: Record<string, string> = {}
  if (input.opencodeProjectId && input.projectId) {
    project_ids[input.opencodeProjectId] = assertMemoryId("project_id", input.projectId)
  }
  const options = input.options ?? {}
  return normalizeConfig(
    {
      schema_version: SCHEMA_VERSION,
      repo_url: input.repoUrl,
      developer_id: input.developerId,
      developer_name: input.developerName,
      device_id: input.deviceId,
      device_name: input.deviceName,
      project_ids,
      sync_interval_seconds: options.sync_interval_seconds,
      scan_interval_seconds: options.scan_interval_seconds,
      analysis_interval_hours: options.analysis_interval_hours,
      context_max_chars: options.context_max_chars,
      collect_all_projects: options.collect_all_projects,
      setup_completed_at: nowIso(),
    },
    { dataDir: "", allowLocalRepo: input.allowLocalRepo === true || options.allowLocalRepo === true },
  )
}

export function projectIdFor(config: MemoryConfig, opencodeProjectId: string, canonical?: string): string {
  const mapped = config.project_ids[opencodeProjectId]
  if (mapped) return mapped
  return normalizeProjectId(opencodeProjectId || canonical || "unknown")
}

export function isAbsoluteDataDir(path: string): boolean {
  return isAbsolute(expandHome(path))
}
