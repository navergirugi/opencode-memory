import { afterEach, describe, expect, it } from "vitest"
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { configPath, loadConfig, validateRepoUrl } from "../src/config.js"
import { performSetup } from "../src/setup.js"
import { gitOrThrow, runGit } from "../src/git.js"
import { noopLogger } from "../src/logger.js"
import { createBareRemote, tempDir } from "./helpers.js"

const savedEnv = {
  token: process.env.OPENCODE_MEMORY_GITHUB_TOKEN,
  local: process.env.OPENCODE_MEMORY_ALLOW_LOCAL_REPOS,
}

afterEach(() => {
  if (savedEnv.token === undefined) delete process.env.OPENCODE_MEMORY_GITHUB_TOKEN
  else process.env.OPENCODE_MEMORY_GITHUB_TOKEN = savedEnv.token
  if (savedEnv.local === undefined) delete process.env.OPENCODE_MEMORY_ALLOW_LOCAL_REPOS
  else process.env.OPENCODE_MEMORY_ALLOW_LOCAL_REPOS = savedEnv.local
})

function deps(dataDir: string, location = { projectID: "oc_proj", directory: "/tmp/project-a", canonical: "/tmp/project-a" }) {
  return {
    dataDir,
    repoDir: join(dataDir, "repo"),
    log: noopLogger,
    location,
    allowLocalRepo: true,
  }
}

async function remoteFile(remote: string, path: string): Promise<string> {
  return gitOrThrow(["show", `refs/heads/main:${path}`], { cwd: remote })
}

describe("setup", () => {
  it("validates IDs, writes a private config, and verifies read/write access", async () => {
    const remote = await createBareRemote()
    const dataDir = await tempDir("setup")
    const result = await performSetup(
      {
        repoURL: remote,
        developerID: "alice",
        developerName: "Alice",
        deviceName: "MacBook",
        opencodeProjectID: "oc_proj",
        projectID: "project-a",
      },
      deps(dataDir),
    )

    expect(result.config.repo_url).toBe(`file://${remote}`)
    expect(result.config.developer_id).toBe("alice")
    expect(result.config.project_ids).toEqual({ oc_proj: "project-a" })
    expect(result.config.setup_completed_at).toBeTruthy()
    expect(result.branch).toBe("main")

    const info = await stat(configPath(dataDir))
    expect(info.mode & 0o777).toBe(0o600)
    const dirInfo = await stat(dataDir)
    expect(dirInfo.mode & 0o777).toBe(0o700)

    const loaded = loadConfig(dataDir, { allowLocalRepo: true })
    expect(loaded.config?.developer_id).toBe("alice")
    expect(loaded.error).toBeUndefined()

    expect(await remoteFile(remote, "config/developers/alice.json")).toContain('"device_id"')
    expect(await remoteFile(remote, "config/projects/project-a.json")).toContain('"project_id": "project-a"')
    expect(await remoteFile(remote, "projects/project-a/conventions.md")).toContain("Team-approved rules")
    expect(await remoteFile(remote, "projects/project-a/shared-context.md")).toContain("Reviewed project context")
  })

  it("rejects an invalid developer ID before touching the repository", async () => {
    const remote = await createBareRemote()
    const dataDir = await tempDir("badid")
    await expect(
      performSetup({ repoURL: remote, developerID: "../escape" }, deps(dataDir)),
    ).rejects.toThrow(/Invalid developer_id/)
    expect(await readdir(dataDir)).toEqual([])
    expect((await runGit(["rev-parse", "--verify", "refs/heads/main"], { cwd: remote })).code).not.toBe(0)
  })

  it("requires a GitHub URL unless local repositories are explicitly allowed", () => {
    process.env.OPENCODE_MEMORY_ALLOW_LOCAL_REPOS = "0"
    expect(() => validateRepoUrl("/tmp/not-a-github-repo")).toThrow(/github\.com/)
    expect(() => validateRepoUrl("https://user:secret@github.com/alice/memory.git")).toThrow(/Do not embed credentials/)
    expect(validateRepoUrl("https://github.com/alice/memory")).toBe("https://github.com/alice/memory.git")
    expect(validateRepoUrl("git@github.com:alice/memory.git")).toBe("git@github.com:alice/memory.git")
  })

  it("never persists a GitHub token and does not log it", async () => {
    process.env.OPENCODE_MEMORY_GITHUB_TOKEN = "ghp_thisIsASecretTokenValue1234567890"
    const remote = await createBareRemote()
    const dataDir = await tempDir("token")
    await performSetup({ repoURL: remote, developerID: "alice" }, deps(dataDir))

    const config = await readFile(configPath(dataDir), "utf8")
    expect(config).not.toContain("ghp_thisIsASecretTokenValue1234567890")
    const gitConfig = await readFile(join(dataDir, "repo", ".git", "config"), "utf8")
    expect(gitConfig).not.toContain("ghp_thisIsASecretTokenValue1234567890")
    expect(gitConfig).not.toContain("OCMEM_GIT_TOKEN")
    const log = await readFile(join(dataDir, "logs", "opencode-memory.log"), "utf8").catch(() => "")
    expect(log).not.toContain("ghp_thisIsASecretTokenValue1234567890")
  })

  it("fails setup when the repository rejects writes", async () => {
    const remote = await createBareRemote()
    await mkdir(join(remote, "hooks"), { recursive: true })
    const hook = join(remote, "hooks", "pre-receive")
    await writeFile(hook, "#!/bin/sh\necho 'denied by test policy' >&2\nexit 1\n", "utf8")
    await chmod(hook, 0o755)

    const dataDir = await tempDir("readonly")
    await expect(
      performSetup({ repoURL: remote, developerID: "alice" }, deps(dataDir)),
    ).rejects.toThrow()
    const loaded = loadConfig(dataDir, { allowLocalRepo: true })
    expect(loaded.config).toBeNull()
  })
})
