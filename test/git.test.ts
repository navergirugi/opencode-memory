import { describe, expect, it } from "vitest"
import { appendFile, mkdir, readFile, rename } from "node:fs/promises"
import { join } from "node:path"
import {
  GitConflictError,
  cloneOrInit,
  commitAll,
  gitOrThrow,
  runGit,
  syncRepository,
  writeRepoScaffold,
} from "../src/git.js"
import type { GitAuth } from "../src/git.js"
import { noopLogger } from "../src/logger.js"
import { createBareRemote, tempDir } from "./helpers.js"

const auth: GitAuth = { method: "ambient", env: {}, description: "test" }

async function setUpDevice(input: {
  remote: string
  dataDir: string
  developerId: string
  projectId?: string
  deviceId: string
}) {
  const repoDir = join(input.dataDir, "repo")
  const cloned = await cloneOrInit({ repoDir, repoUrl: input.remote, auth, log: noopLogger })
  await writeRepoScaffold(repoDir, {
    developerId: input.developerId,
    deviceId: input.deviceId,
    projectId: input.projectId ?? "proj",
    opencodeProjectId: "oc-project",
    projectName: "Project",
    repoUrl: input.remote,
  })
  await commitAll(repoDir, `memory: initialize ${input.developerId}`)
  await syncRepository({ repoDir, dataDir: input.dataDir, auth, log: noopLogger })
  return { repoDir, branch: cloned.branch }
}

async function head(repoDir: string): Promise<string> {
  return (await gitOrThrow(["rev-parse", "HEAD"], { cwd: repoDir })).trim()
}

async function remoteHead(remote: string): Promise<string> {
  return (await gitOrThrow(["rev-parse", "refs/heads/main"], { cwd: remote })).trim()
}

async function isAncestor(repoDir: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runGit(["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repoDir })
  return result.code === 0
}

describe("git sync", () => {
  it("merges append-only JSONL from two devices without losing records", async () => {
    const remote = await createBareRemote()
    const dataA = await tempDir("devA")
    const dataB = await tempDir("devB")
    const a = await setUpDevice({ remote, dataDir: dataA, developerId: "alice", deviceId: "dev_a" })
    const b = await setUpDevice({ remote, dataDir: dataB, developerId: "alice", deviceId: "dev_b" })

    const fileA = join(a.repoDir, "histories", "proj", "alice", "sessions", "ses_1.jsonl")
    const fileB = join(b.repoDir, "histories", "proj", "alice", "sessions", "ses_1.jsonl")
    await mkdir(join(a.repoDir, "histories", "proj", "alice", "sessions"), { recursive: true })
    await mkdir(join(b.repoDir, "histories", "proj", "alice", "sessions"), { recursive: true })

    // A creates the base file first so both devices start from the same content.
    await appendFile(fileA, JSON.stringify({ record_id: "a1", device: "dev_a" }) + "\n")
    await commitAll(a.repoDir, "memory: a1")
    await syncRepository({ repoDir: a.repoDir, dataDir: dataA, auth, log: noopLogger })
    await gitOrThrow(["pull", "--ff-only", "origin", "main"], { cwd: b.repoDir })

    const before = await remoteHead(remote)

    await appendFile(fileA, JSON.stringify({ record_id: "a2", device: "dev_a" }) + "\n")
    await commitAll(a.repoDir, "memory: a2")
    await syncRepository({ repoDir: a.repoDir, dataDir: dataA, auth, log: noopLogger })

    await appendFile(fileB, JSON.stringify({ record_id: "b1", device: "dev_b" }) + "\n")
    await commitAll(b.repoDir, "memory: b1")
    await syncRepository({ repoDir: b.repoDir, dataDir: dataB, auth, log: noopLogger })

    const merged = await readFile(fileB, "utf8")
    expect(merged).toContain('"record_id":"a2"')
    expect(merged).toContain('"record_id":"b1"')

    const after = await remoteHead(remote)
    // A fast-forward, not a force push: the previous remote head is still an ancestor.
    expect(await isAncestor(b.repoDir, before, after)).toBe(true)
  })

  it("retries a rejected push, fetches, rebases, and never force-pushes", async () => {
    const remote = await createBareRemote()
    const dataDir = await tempDir("retry")
    const device = await setUpDevice({ remote, dataDir, developerId: "alice", deviceId: "dev_a" })

    // Reject the first push only, simulating another device winning the race.
    const hook = join(remote, "hooks", "pre-receive")
    const counter = join(remote, "push-attempts")
    await mkdir(join(remote, "hooks"), { recursive: true })
    await import("node:fs/promises").then(({ writeFile, chmod }) =>
      writeFile(
        hook,
        `#!/bin/sh\ncount=0\n[ -f '${counter}' ] && count=$(cat '${counter}')\ncount=$((count + 1))\necho "$count" > '${counter}'\nif [ "$count" -eq 1 ]; then\n  echo "rejected by test hook" >&2\n  exit 1\nfi\nexit 0\n`,
        "utf8",
      ).then(() => chmod(hook, 0o755)),
    )

    const file = join(device.repoDir, "histories", "proj", "alice", "sessions", "ses_retry.jsonl")
    await mkdir(join(device.repoDir, "histories", "proj", "alice", "sessions"), { recursive: true })
    await appendFile(file, JSON.stringify({ record_id: "retry-1" }) + "\n")
    await commitAll(device.repoDir, "memory: retry")

    const before = await remoteHead(remote)
    const outcome = await syncRepository({ repoDir: device.repoDir, dataDir, auth, log: noopLogger, maxRetries: 2 })
    expect(outcome.pushed).toBe(true)
    expect(Number(await readFile(counter, "utf8"))).toBe(2)

    const after = await remoteHead(remote)
    expect(await isAncestor(device.repoDir, before, after)).toBe(true)
  })

  it("preserves unresolved non-JSONL conflicts and leaves local commits intact", async () => {
    const remote = await createBareRemote()
    const dataA = await tempDir("confA")
    const dataB = await tempDir("confB")
    const a = await setUpDevice({ remote, dataDir: dataA, developerId: "alice", deviceId: "dev_a" })
    const b = await setUpDevice({ remote, dataDir: dataB, developerId: "bob", deviceId: "dev_b" })

    const relative = join("config", "developers", "alice.json")
    await appendFile(join(a.repoDir, relative), "\n// edited by alice\n", "utf8")
    await commitAll(a.repoDir, "memory: alice registry edit")
    await syncRepository({ repoDir: a.repoDir, dataDir: dataA, auth, log: noopLogger })
    const remoteAfterA = await remoteHead(remote)

    const conflicted = join(b.repoDir, relative)
    const original = await readFile(conflicted, "utf8")
    await appendFile(conflicted, "\n// conflicting bob edit\n", "utf8")
    await commitAll(b.repoDir, "memory: bob registry edit")
    const localHead = await head(b.repoDir)

    let error: unknown
    try {
      await syncRepository({ repoDir: b.repoDir, dataDir: dataB, auth, log: noopLogger, maxRetries: 0 })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(GitConflictError)
    const conflict = error as GitConflictError
    expect(conflict.files).toContain(relative)
    expect(conflict.savedTo).toBeTruthy()
    const preserved = await readFile(join(conflict.savedTo!, relative), "utf8")
    expect(preserved).toContain("<<<<<<<")
    expect(await readFile(join(conflict.savedTo!, "README.txt"), "utf8")).toContain(relative)

    // Local commit was not discarded, and the remote was not rewritten.
    expect(await head(b.repoDir)).toBe(localHead)
    expect(await remoteHead(remote)).toBe(remoteAfterA)
    expect(await readFile(conflicted, "utf8")).toBe(original + "\n// conflicting bob edit\n")

    const status = await gitOrThrow(["status", "--porcelain"], { cwd: b.repoDir })
    expect(status).toBe("")
    const rebaseState = await runGit(["rebase", "--show-current-patch"], { cwd: b.repoDir })
    expect(rebaseState.code).not.toBe(0)
  })

  it("keeps local commits while offline and pushes after the remote returns", async () => {
    const remote = await createBareRemote()
    const dataDir = await tempDir("offline")
    const device = await setUpDevice({ remote, dataDir, developerId: "alice", deviceId: "dev_a" })
    const hidden = `${remote}.offline`
    await rename(remote, hidden)

    const file = join(device.repoDir, "histories", "proj", "alice", "sessions", "ses_offline.jsonl")
    await mkdir(join(device.repoDir, "histories", "proj", "alice", "sessions"), { recursive: true })
    await appendFile(file, JSON.stringify({ record_id: "offline-1" }) + "\n")
    await commitAll(device.repoDir, "memory: offline record")

    await expect(
      syncRepository({ repoDir: device.repoDir, dataDir, auth, log: noopLogger, maxRetries: 0 }),
    ).rejects.toThrow()
    const localHead = await head(device.repoDir)

    await rename(hidden, remote)
    const outcome = await syncRepository({ repoDir: device.repoDir, dataDir, auth, log: noopLogger, maxRetries: 1 })
    expect(outcome.pushed).toBe(true)
    expect(await remoteHead(remote)).toBe(localHead)
  })

  it("keeps developer histories in separate files across devices", async () => {
    const remote = await createBareRemote()
    const dataA = await tempDir("sepA")
    const dataB = await tempDir("sepB")
    const a = await setUpDevice({ remote, dataDir: dataA, developerId: "alice", deviceId: "dev_a" })
    const b = await setUpDevice({ remote, dataDir: dataB, developerId: "bob", deviceId: "dev_b" })

    const alicePath = join(a.repoDir, "histories", "proj", "alice", "sessions", "ses_a.jsonl")
    const bobPath = join(b.repoDir, "histories", "proj", "bob", "sessions", "ses_b.jsonl")
    await mkdir(join(a.repoDir, "histories", "proj", "alice", "sessions"), { recursive: true })
    await mkdir(join(b.repoDir, "histories", "proj", "bob", "sessions"), { recursive: true })
    await appendFile(alicePath, JSON.stringify({ record_id: "alice-1" }) + "\n")
    await appendFile(bobPath, JSON.stringify({ record_id: "bob-1" }) + "\n")
    await commitAll(a.repoDir, "memory: alice")
    await syncRepository({ repoDir: a.repoDir, dataDir: dataA, auth, log: noopLogger })
    await commitAll(b.repoDir, "memory: bob")
    await syncRepository({ repoDir: b.repoDir, dataDir: dataB, auth, log: noopLogger })

    const alice = await readFile(join(b.repoDir, "histories", "proj", "alice", "sessions", "ses_a.jsonl"), "utf8")
    const bob = await readFile(join(b.repoDir, "histories", "proj", "bob", "sessions", "ses_b.jsonl"), "utf8")
    expect(alice.trim()).toBe(JSON.stringify({ record_id: "alice-1" }))
    expect(bob.trim()).toBe(JSON.stringify({ record_id: "bob-1" }))
  })
})
