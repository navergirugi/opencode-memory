import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGit } from "../src/git.js"

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `ocmem-${prefix}-`))
}

export async function createBareRemote(): Promise<string> {
  const dir = await tempDir("remote")
  const result = await runGit(["init", "--bare", "-b", "main", dir])
  if (result.code !== 0) throw new Error(result.stderr)
  return dir
}

export function fileUrl(path: string): string {
  return `file://${path}`
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true }).catch(() => undefined)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T
}

export async function gitLog(path: string): Promise<string> {
  const result = await runGit(["log", "--oneline", "--all"], { cwd: path })
  return result.stdout
}
