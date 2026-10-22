import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { shortHash } from "./ids.js"
import { redactText, redactUrl } from "./redact.js"
import type { Logger } from "./logger.js"

export class GitError extends Error {
  readonly code: number | null
  readonly stderr: string
  readonly args: string[]

  constructor(message: string, args: string[], code: number | null, stderr: string) {
    super(message)
    this.name = "GitError"
    this.args = args
    this.code = code
    this.stderr = redactText(stderr, 4_000)
  }
}

export class GitConflictError extends GitError {
  readonly files: string[]
  readonly savedTo?: string

  constructor(message: string, args: string[], code: number | null, stderr: string, files: string[], savedTo?: string) {
    super(message, args, code, stderr)
    this.name = "GitConflictError"
    this.files = files
    this.savedTo = savedTo
  }
}

export interface GitAuth {
  method: "token" | "ambient" | "ssh"
  env: NodeJS.ProcessEnv
  description: string
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  input?: string
}

export interface GitResult {
  stdout: string
  stderr: string
  code: number
}

const MAX_OUTPUT = 4 * 1024 * 1024

export function runGit(args: string[], options: RunOptions = {}): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      reject(new GitError(`git ${args[0] ?? ""} timed out after ${options.timeoutMs ?? 60_000}ms`, args, null, stderr))
    }, options.timeoutMs ?? 60_000)

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8")
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new GitError(`Could not start git: ${error.message}`, args, null, stderr))
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ stdout, stderr, code: code ?? -1 })
    })
    if (options.input) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

export async function gitOrThrow(args: string[], options: RunOptions = {}): Promise<string> {
  const result = await runGit(args, options)
  if (result.code !== 0) {
    throw new GitError(
      `git ${args[0] ?? ""} failed: ${redactText(result.stderr.trim() || `exit ${result.code}`, 500)}`,
      args,
      result.code,
      result.stderr,
    )
  }
  return result.stdout
}

export function isGitRepository(directory: string): boolean {
  return existsSync(join(directory, ".git"))
}

export async function resolveGitAuth(repoUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<GitAuth> {
  if (/^(git@|ssh:\/\/)/.test(repoUrl)) {
    return { method: "ssh", env: {}, description: "SSH agent or key configured for github.com" }
  }

  let token = env.OPENCODE_MEMORY_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN
  let source = token ? "environment variable" : ""

  if (!token) {
    const candidate = await runGhAuthToken()
    if (candidate) {
      token = candidate
      source = "gh auth token"
    }
  }

  if (!token) {
    return {
      method: "ambient",
      env: {},
      description: "Git credential helper (run `gh auth login` or configure a credential helper if authentication fails)",
    }
  }

  // The token is passed through the child environment and a transient credential
  // helper. It is never written to the repository config or the log.
  const envWithToken: NodeJS.ProcessEnv = {
    ...env,
    OCMEM_GIT_TOKEN: token,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0:
      '!f() { test "$1" = get && printf "%s\\n" "username=x-access-token" "password=${OCMEM_GIT_TOKEN}"; }; f',
  }
  return { method: "token", env: envWithToken, description: `HTTPS token from ${source}` }
}

async function runGhAuthToken(): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    let output = ""
    let settled = false
    const child = spawn("gh", ["auth", "token"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    })
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill("SIGKILL")
        resolvePromise(undefined)
      }
    }, 5_000)
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 4_096) output += chunk.toString("utf8")
    })
    child.on("error", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(undefined)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(code === 0 ? output.trim() || undefined : undefined)
    })
  })
}

async function ensureIdentity(repoDir: string): Promise<void> {
  const name = await runGit(["config", "user.name"], { cwd: repoDir })
  if (name.code !== 0 || !name.stdout.trim()) {
    await gitOrThrow(["config", "user.name", "OpenCode Memory"], { cwd: repoDir })
  }
  const email = await runGit(["config", "user.email"], { cwd: repoDir })
  if (email.code !== 0 || !email.stdout.trim()) {
    await gitOrThrow(["config", "user.email", "opencode-memory@localhost"], { cwd: repoDir })
  }
}

export async function currentBranch(repoDir: string): Promise<string> {
  const result = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repoDir })
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : "main"
}

export async function hasCommits(repoDir: string): Promise<boolean> {
  const result = await runGit(["rev-parse", "--verify", "HEAD"], { cwd: repoDir })
  return result.code === 0
}

export async function remoteUrl(repoDir: string): Promise<string | undefined> {
  const result = await runGit(["remote", "get-url", "origin"], { cwd: repoDir })
  return result.code === 0 ? result.stdout.trim() : undefined
}

export interface CloneOptions {
  repoDir: string
  repoUrl: string
  auth: GitAuth
  log: Logger
}

/** Clone the memory repository, or initialize an empty one. */
export async function cloneOrInit(options: CloneOptions): Promise<{ branch: string; initialized: boolean }> {
  const { repoDir, repoUrl, auth, log } = options
  mkdirSync(dirname(repoDir), { recursive: true })

  if (isGitRepository(repoDir)) {
    const existing = await remoteUrl(repoDir)
    if (existing && existing !== repoUrl) {
      throw new GitError(
        `The existing local memory repository at ${repoDir} uses ${redactUrl(existing)}, not ${redactUrl(repoUrl)}.`,
        ["remote", "get-url", "origin"],
        0,
        "",
      )
    }
    await ensureIdentity(repoDir)
    return { branch: await currentBranch(repoDir), initialized: false }
  }

  if (existsSync(repoDir) && statSync(repoDir).isDirectory()) {
    const probe = await runGit(["rev-parse", "--git-dir"], { cwd: repoDir })
    if (probe.code !== 0) {
      const entries = readdirSafe(repoDir)
      if (entries.length > 0) {
        throw new GitError(
          `The memory data directory ${repoDir} exists and is not a Git repository. Move it or choose another data directory.`,
          [],
          0,
          "",
        )
      }
    }
  }

  const remote = await runGit(["ls-remote", "--symref", repoUrl, "HEAD"], {
    env: auth.env,
    timeoutMs: 60_000,
  })
  if (remote.code !== 0) {
    throw new GitError(
      `Could not read ${redactUrl(repoUrl)}. ${authFailureHint(auth, remote.stderr)}`,
      ["ls-remote", repoUrl],
      remote.code,
      remote.stderr,
    )
  }
  const remoteBranch = /ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(remote.stdout)?.[1] ?? "main"
  const empty = remote.stdout.trim() === ""

  if (!empty) {
    log.info("Cloning private memory repository", { repo: redactUrl(repoUrl) })
    const clone = await runGit(["clone", "--origin", "origin", repoUrl, repoDir], {
      env: auth.env,
      timeoutMs: 180_000,
    })
    if (clone.code !== 0) {
      throw new GitError(
        `Could not clone ${redactUrl(repoUrl)}. ${authFailureHint(auth, clone.stderr)}`,
        ["clone", repoUrl, repoDir],
        clone.code,
        clone.stderr,
      )
    }
    await ensureIdentity(repoDir)
    return { branch: await currentBranch(repoDir), initialized: false }
  }

  log.info("Initializing an empty private memory repository", { repo: redactUrl(repoUrl) })
  mkdirSync(repoDir, { recursive: true })
  await gitOrThrow(["init", "-b", remoteBranch], { cwd: repoDir })
  await gitOrThrow(["remote", "add", "origin", repoUrl], { cwd: repoDir })
  await ensureIdentity(repoDir)
  return { branch: remoteBranch, initialized: true }
}

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function authFailureHint(auth: GitAuth, stderr: string): string {
  if (/permission denied|authentication failed|could not read username|not found|repository not found/i.test(stderr)) {
    return `Authentication or repository access failed (${auth.description}). Verify the repository exists, is private, and that this account can read it. For HTTPS, run \`gh auth login\` or set OPENCODE_MEMORY_GITHUB_TOKEN.`
  }
  if (/could not resolve host|network|timed out|connection/i.test(stderr)) {
    return "The network is unavailable. The local queue will keep new records until the next successful sync."
  }
  return "Check the repository URL and your Git credentials."
}

export interface SyncOptions {
  repoDir: string
  dataDir: string
  auth: GitAuth
  log: Logger
  maxRetries?: number
}

export interface SyncOutcome {
  pushed: boolean
  commits: number
  branch: string
}

/** Fetch, rebase local commits, and push. Never force-pushes. */
export async function syncRepository(options: SyncOptions): Promise<SyncOutcome> {
  const { repoDir, dataDir, auth, log } = options
  const maxRetries = options.maxRetries ?? 3
  const branch = await currentBranch(repoDir)

  await fetchRemote(repoDir, branch, auth)
  await rebaseOntoRemote(repoDir, dataDir, branch, log)

  let lastError = ""
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const push = await runGit(["push", "origin", `HEAD:refs/heads/${branch}`], {
      cwd: repoDir,
      env: auth.env,
      timeoutMs: 120_000,
    })
    if (push.code === 0) {
      return { pushed: true, commits: 0, branch }
    }
    lastError = push.stderr
    if (!/rejected|non-fast-forward|fetch first|failed to push/i.test(push.stderr)) {
      throw new GitError(`Push failed: ${redactText(push.stderr.trim(), 500)}`, ["push"], push.code, push.stderr)
    }
    // Credential/policy denials will reject every retry; report immediately.
    if (/permission denied|could not read username|authentication failed|denied by/i.test(push.stderr)) {
      throw new GitError(
        `Push was rejected by the remote. Local commits are preserved. ${redactText(push.stderr.trim(), 500)}`,
        ["push"],
        push.code,
        push.stderr,
      )
    }
    if (attempt === maxRetries) break
    const delay = Math.min(8_000, 1_000 * 2 ** attempt)
    log.warn("Push rejected; retrying after fetching remote changes", { attempt: attempt + 1, delay })
    await sleep(delay)
    await fetchRemote(repoDir, branch, auth)
    await rebaseOntoRemote(repoDir, dataDir, branch, log)
  }

  throw new GitError(
    `Push was rejected after ${maxRetries + 1} attempts. Local commits are preserved; the next run will retry. ${redactText(lastError, 400)}`,
    ["push"],
    1,
    lastError,
  )
}

async function fetchRemote(repoDir: string, branch: string, auth: GitAuth): Promise<void> {
  const fetch = await runGit(["fetch", "--prune", "origin", branch], {
    cwd: repoDir,
    env: auth.env,
    timeoutMs: 120_000,
  })
  if (fetch.code !== 0) {
    if (/couldn't find remote ref/i.test(fetch.stderr)) return
    throw new GitError(
      `Could not fetch origin/${branch}. ${authFailureHint(auth, fetch.stderr)}`,
      ["fetch", "origin", branch],
      fetch.code,
      fetch.stderr,
    )
  }
}

async function remoteExists(repoDir: string, branch: string): Promise<boolean> {
  const result = await runGit(["rev-parse", "--verify", `origin/${branch}`], { cwd: repoDir })
  return result.code === 0
}

async function rebaseOntoRemote(repoDir: string, dataDir: string, branch: string, log: Logger): Promise<void> {
  if (!(await remoteExists(repoDir, branch))) return
  const rebase = await runGit(["rebase", `origin/${branch}`], { cwd: repoDir, timeoutMs: 120_000 })
  if (rebase.code === 0) return

  const status = await runGit(["diff", "--name-only", "--diff-filter=U"], { cwd: repoDir })
  const files = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const savedTo = files.length > 0 ? preserveConflicts(repoDir, dataDir, files, log) : undefined
  await runGit(["rebase", "--abort"], { cwd: repoDir })
  throw new GitConflictError(
    files.length > 0
      ? `A Git conflict could not be merged automatically. Conflicting files were preserved${savedTo ? ` under ${savedTo}` : ""}; local commits were left intact. Resolve the conflict in the private repository, then run sync again.`
      : `Rebase failed: ${redactText(rebase.stderr.trim(), 400)}`,
    ["rebase", `origin/${branch}`],
    rebase.code,
    rebase.stderr,
    files,
    savedTo,
  )
}

function preserveConflicts(repoDir: string, dataDir: string, files: string[], log: Logger): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const target = join(dataDir, "conflicts", stamp)
  for (const file of files) {
    const source = resolve(repoDir, file)
    const rel = relative(repoDir, source)
    if (rel.startsWith("..") || isAbsolute(rel)) continue
    const destination = join(target, rel)
    try {
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(source, destination)
    } catch {
      // Preserving a conflict copy is best-effort.
    }
  }
  try {
    writeFileSync(
      join(target, "README.txt"),
      `OpenCode Memory conflict snapshot\n\nFiles:\n${files.map((f) => `- ${f}`).join("\n")}\n\nLocal commits were preserved. Resolve the conflict in the private memory repository, commit, and run sync again.\n`,
      "utf8",
    )
  } catch {
    // ignored
  }
  log.warn("Preserved conflicting files", { target, count: files.length })
  return target
}

export async function commitAll(repoDir: string, message: string): Promise<boolean> {
  await gitOrThrow(["add", "-A"], { cwd: repoDir })
  const diff = await runGit(["diff", "--cached", "--quiet"], { cwd: repoDir })
  if (diff.code === 0) return false
  await gitOrThrow(["commit", "-m", message], { cwd: repoDir })
  return true
}

export interface PendingInfo {
  commits: number
  dirty: number
}

export async function pendingGitWork(repoDir: string): Promise<PendingInfo> {
  if (!isGitRepository(repoDir)) return { commits: 0, dirty: 0 }
  const branch = await currentBranch(repoDir)
  const dirtyResult = await runGit(["status", "--porcelain"], { cwd: repoDir })
  const dirty = dirtyResult.stdout.split("\n").filter((line) => line.trim()).length
  const ahead = await runGit(["rev-list", "--count", `origin/${branch}..HEAD`], { cwd: repoDir })
  const commits = ahead.code === 0 ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : 0
  return { commits, dirty }
}

export async function pushDryRun(repoDir: string, auth: GitAuth): Promise<{ ok: boolean; detail: string }> {
  const branch = await currentBranch(repoDir)
  const result = await runGit(["push", "--dry-run", "origin", `HEAD:refs/heads/${branch}`], {
    cwd: repoDir,
    env: auth.env,
    timeoutMs: 60_000,
  })
  if (result.code === 0) return { ok: true, detail: `Write access confirmed for origin/${branch} (dry run).` }
  return { ok: false, detail: authFailureHint(auth, result.stderr) }
}

export async function writeRepoScaffold(
  repoDir: string,
  input: {
    developerId: string
    developerName?: string
    deviceId: string
    deviceName?: string
    projectId?: string
    opencodeProjectId?: string
    projectName?: string
    canonicalHint?: string
    repoUrl: string
  },
): Promise<void> {
  const writeIfMissing = (path: string, content: string) => {
    const full = join(repoDir, path)
    if (existsSync(full)) return
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, "utf8")
  }

  writeIfMissing(
    ".gitattributes",
    "# Session histories are append-only JSON lines. Union merge keeps both sides; record IDs deduplicate on read.\nhistories/**/*.jsonl merge=union\nanalysis/**/*.md merge=union\n",
  )
  writeIfMissing(".gitignore", ".DS_Store\n*.tmp\n*.log\n")
  writeIfMissing(
    "README.md",
    `# OpenCode Memory (private)

This repository is private developer memory managed by the \`opencode-memory-context\` OpenCode plugin.

- \`config/\` — per-developer and per-project registry entries
- \`developers/\` — global developer profiles
- \`projects/\` — shared project context and per-project developer profiles
- \`histories/\` — append-only session records (JSONL)
- \`analysis/\` — analysis details and shared-context proposals
- \`sync/checkpoints/\` — incremental analysis checkpoints

Keep this repository private. Do not commit access tokens or secrets.
`,
  )
  writeIfMissing(
    "config/schema.json",
    JSON.stringify(
      {
        schema_version: 1,
        layout: "One file per developer/project to minimize Git conflicts.",
        record_schema:
          "Each histories/<project>/<developer>/sessions/<session>.jsonl line is a JSON object with schema_version, record_id, kind, project_id, developer_id, device_id, session_id, message_id, created_at, collected_at, source and payload.",
      },
      null,
      2,
    ) + "\n",
  )

  const developer = {
    schema_version: 1,
    developer_id: input.developerId,
    display_name: input.developerName ?? input.developerId,
    devices: [{ device_id: input.deviceId, name: input.deviceName ?? input.deviceId }],
    updated_at: new Date().toISOString(),
  }
  const developerPath = `config/developers/${input.developerId}.json`
  if (existsSync(join(repoDir, developerPath))) {
    try {
      const existing = JSON.parse(readFileSync(join(repoDir, developerPath), "utf8")) as Record<string, any>
      const devices: any[] = Array.isArray(existing.devices) ? existing.devices : []
      if (!devices.some((entry) => entry?.device_id === input.deviceId)) devices.push(developer.devices[0])
      existing.devices = devices
      existing.display_name = existing.display_name ?? developer.display_name
      existing.updated_at = new Date().toISOString()
      writeFileSync(join(repoDir, developerPath), `${JSON.stringify(existing, null, 2)}\n`, "utf8")
    } catch {
      writeFileSync(join(repoDir, developerPath), `${JSON.stringify(developer, null, 2)}\n`, "utf8")
    }
  } else {
    writeIfMissing(developerPath, `${JSON.stringify(developer, null, 2)}\n`)
  }

  if (input.projectId) {
    const project = {
      schema_version: 1,
      project_id: input.projectId,
      name: input.projectName ?? input.projectId,
      opencode_project_id: input.opencodeProjectId,
      canonical_hint: input.canonicalHint,
      repository: input.repoUrl,
      created_at: new Date().toISOString(),
    }
    const projectConfigPath = `config/projects/${input.projectId}.json`
    writeIfMissing(projectConfigPath, `${JSON.stringify(project, null, 2)}\n`)
    writeIfMissing(`projects/${input.projectId}/project.json`, `${JSON.stringify(project, null, 2)}\n`)
    writeIfMissing(
      `projects/${input.projectId}/conventions.md`,
      `# ${input.projectName ?? input.projectId} conventions\n\nTeam-approved rules live here. The analyzer never edits this file automatically.\n`,
    )
    writeIfMissing(
      `projects/${input.projectId}/shared-context.md`,
      `# ${input.projectName ?? input.projectId} shared context\n\nReviewed project context for every developer. Keep this file concise.\n`,
    )
    writeIfMissing(`histories/${input.projectId}/.gitkeep`, "")
    writeIfMissing(`projects/${input.projectId}/developers/${input.developerId}/.gitkeep`, "")
  }
  writeIfMissing(`developers/${input.developerId}/preferences.md`, "# Personal preferences\n\nUser-maintained notes. The analyzer does not overwrite this file.\n")
  writeIfMissing("sync/checkpoints/.gitkeep", "")
  writeIfMissing("analysis/developers/.gitkeep", "")
  writeIfMissing("analysis/projects/.gitkeep", "")
  writeIfMissing("histories/.gitkeep", "")
}

export function sanitizeGitError(error: unknown): string {
  if (error instanceof GitError) return redactText(error.message, 1_200)
  if (error instanceof Error) return redactText(error.message, 1_200)
  return "Unknown Git error"
}

const processLocks = new Map<string, Promise<unknown>>()

/** Serialize work within this process, and use a mkdir lock across processes. */
export async function withRepoLock<T>(dataDir: string, name: string, fn: () => Promise<T>): Promise<T> {
  const key = `${dataDir}:${name}`
  const previous = processLocks.get(key) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(async () => {
    const lockPath = join(dataDir, "state", "locks", `${shortHash(key, 16)}.lock`)
    mkdirSync(dirname(lockPath), { recursive: true })
    const deadline = Date.now() + 30_000
    for (;;) {
      try {
        mkdirSync(lockPath)
        break
      } catch {
        try {
          const age = Date.now() - statSync(lockPath).mtimeMs
          if (age > 10 * 60_000) {
            rmSync(lockPath, { recursive: true, force: true })
            continue
          }
        } catch {
          continue
        }
        if (Date.now() > deadline) {
          throw new Error("Another OpenCode Memory process is using the repository. Try again shortly.")
        }
        await sleep(200)
      }
    }
    try {
      return await fn()
    } finally {
      rmSync(lockPath, { recursive: true, force: true })
    }
  })
  processLocks.set(key, run)
  try {
    return (await run) as T
  } finally {
    if (processLocks.get(key) === run) processLocks.delete(key)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
