import { basename } from "node:path"
import { normalizeProjectId, assertMemoryId, newDeviceId, nowIso } from "./ids.js"
import type { Logger } from "./logger.js"
import type { MemoryConfig, SetupInput } from "./types.js"
import {
  cloneOrInit,
  commitAll,
  pushDryRun,
  resolveGitAuth,
  sanitizeGitError,
  syncRepository,
  withRepoLock,
  writeRepoScaffold,
} from "./git.js"
import { createConfigFromSetup, loadConfig, saveConfig, validateRepoUrl, ConfigError } from "./config.js"

export interface SetupDeps {
  dataDir: string
  repoDir: string
  log: Logger
  location: { projectID: string; directory: string; canonical?: string; projectName?: string }
  options?: Record<string, unknown>
  allowLocalRepo?: boolean
  now?: () => Date
}

export interface SetupResult {
  config: MemoryConfig
  repoDir: string
  branch: string
  authMethod: string
}

export async function performSetup(input: SetupInput, deps: SetupDeps): Promise<SetupResult> {
  const repoUrl = validateRepoUrl(input.repoURL, { allowLocal: deps.allowLocalRepo })
  const developerId = assertMemoryId("developer_id", input.developerID)
  const opencodeProjectId = input.opencodeProjectID ?? deps.location.projectID
  const mappingKey = opencodeProjectId || "default"
  const projectId = input.projectID
    ? assertMemoryId("project_id", input.projectID)
    : normalizeProjectId(opencodeProjectId || deps.location.canonical || "project")
  const projectName = deps.location.projectName ?? (deps.location.canonical ? basename(deps.location.canonical) : projectId)

  const existing = loadConfig(deps.dataDir, deps.options ?? {})
  const deviceId = existing.config?.device_id ?? newDeviceId()
  const deviceName = input.deviceName ?? existing.config?.device_name ?? undefined
  const auth = await resolveGitAuth(repoUrl)

  deps.log.info("Starting memory repository setup", { repo: repoUrl, developerId, projectId, auth: auth.method })

  return withRepoLock(deps.dataDir, "setup", async () => {
    let branch: string
    try {
      const cloned = await cloneOrInit({ repoDir: deps.repoDir, repoUrl, auth, log: deps.log })
      branch = cloned.branch
      await writeRepoScaffold(deps.repoDir, {
        developerId,
        developerName: input.developerName,
        deviceId,
        deviceName,
        projectId,
        opencodeProjectId: mappingKey,
        projectName,
        canonicalHint: deps.location.canonical ?? deps.location.directory,
        repoUrl,
      })
      await commitAll(deps.repoDir, `memory: initialize ${developerId} / ${projectId}`)
      await syncRepository({ repoDir: deps.repoDir, dataDir: deps.dataDir, auth, log: deps.log })
      const writeCheck = await pushDryRun(deps.repoDir, auth)
      if (!writeCheck.ok) {
        throw new ConfigError(`The repository is readable but write access failed. ${writeCheck.detail}`)
      }
    } catch (error) {
      if (error instanceof ConfigError) throw error
      throw new ConfigError(sanitizeGitError(error))
    }

    const config = createConfigFromSetup({
      repoUrl,
      developerId,
      developerName: input.developerName,
      deviceId,
      deviceName,
      opencodeProjectId: mappingKey,
      projectId,
      options: deps.options,
      allowLocalRepo: deps.allowLocalRepo,
    })
    config.project_ids[mappingKey] = projectId
    config.setup_completed_at = (deps.now?.() ?? new Date()).toISOString()
    saveConfig(deps.dataDir, config)
    deps.log.info("Memory repository setup complete", { developerId, projectId, deviceId })
    return { config, repoDir: deps.repoDir, branch, authMethod: auth.description }
  })
}

export function setupUsage(): string {
  return [
    "OpenCode Memory setup requires:",
    "1. A private GitHub repository URL (HTTPS or SSH), e.g. https://github.com/you/opencode-memory-private.git",
    "2. A stable developer ID (letters, digits, dot, underscore, hyphen)",
    "3. Optional display name, device name, and project ID",
    "",
    "Run the `opencode_memory` tool with action=setup and these fields, for example:",
    '{"action":"setup","repo_url":"https://github.com/you/opencode-memory-private.git","developer_id":"alice"}',
    "",
    "Authentication: run `gh auth login`, configure a Git credential helper, use SSH, or set OPENCODE_MEMORY_GITHUB_TOKEN for the OpenCode server process. Tokens are never written to the memory repository.",
  ].join("\n")
}

export function setupSummary(result: SetupResult): string {
  return [
    "OpenCode Memory is configured.",
    `- Repository: ${result.config.repo_url}`,
    `- Developer: ${result.config.developer_id}`,
    `- Device: ${result.config.device_id}`,
    `- Project mapping: ${Object.entries(result.config.project_ids)
      .map(([key, value]) => `${key} -> ${value}`)
      .join(", ")}`,
    `- Branch: ${result.branch}`,
    `- Authentication: ${result.authMethod}`,
    `- Setup completed: ${result.config.setup_completed_at ?? nowIso()}`,
    "",
    "Records are queued locally first. If the network or GitHub is unavailable, OpenCode keeps working and retries later.",
  ].join("\n")
}
