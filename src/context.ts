import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Profile } from "./types.js"

export interface ContextSources {
  repoDir: string
  developerID: string
  projectID?: string
  projectName?: string
  maxChars: number
}

interface Section {
  title: string
  priority: number
  lines: string[]
}

async function readText(path: string): Promise<string> {
  if (!existsSync(path)) return ""
  return readFile(path, "utf8").catch(() => "")
}

async function readProfile(path: string): Promise<Profile | null> {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, "utf8")) as Profile
  } catch {
    return null
  }
}

/**
 * Build a small, prioritized context block. Project rules come first, then
 * project-scoped personal context, then global personal preferences.
 */
export async function buildContextText(sources: ContextSources): Promise<string> {
  if (sources.maxChars <= 0) return ""
  const sections: Section[] = []

  if (sources.projectID) {
    const base = join(sources.repoDir, "projects", sources.projectID)
    const conventions = await readText(join(base, "conventions.md"))
    const shared = await readText(join(base, "shared-context.md"))
    if (conventions.trim()) {
      sections.push({ title: "Project conventions (authoritative)", priority: 0, lines: markdownLines(conventions, 40) })
    }
    if (shared.trim()) {
      sections.push({ title: "Project shared context", priority: 1, lines: markdownLines(shared, 40) })
    }
    const projectProfile = await readProfile(join(base, "developers", sources.developerID, "profile.json"))
    const rendered = renderProfile(projectProfile, "project")
    if (rendered.length) {
      sections.push({ title: "Your project profile (inferred)", priority: 2, lines: rendered })
    }
  }

  const globalProfile = await readProfile(join(sources.repoDir, "developers", sources.developerID, "profile.json"))
  const renderedGlobal = renderProfile(globalProfile, "global")
  const personalNotes = await readText(join(sources.repoDir, "developers", sources.developerID, "preferences.md"))
  if (personalNotes.trim()) {
    sections.push({ title: "Your explicit preferences", priority: 3, lines: markdownLines(personalNotes, 20) })
  }
  const deepProfile = await readText(join(sources.repoDir, "developers", sources.developerID, "deep-profile.md"))
  if (deepProfile.trim()) {
    sections.push({ title: "Your deep developer profile (LLM-generated, hints only)", priority: 4, lines: markdownLines(deepProfile, 20) })
  }
  if (renderedGlobal.length) {
    sections.push({ title: "Your global preferences (inferred)", priority: 5, lines: renderedGlobal })
  }

  if (sections.length === 0) return ""

  const header = [
    "<!-- opencode-memory:context:v1 -->",
    "The following notes come from the user's private OpenCode Memory repository.",
    "Project rules take precedence over personal preferences. Treat inferred items as hints, not facts; follow the user's current instructions first.",
  ]
  const seen = new Set<string>()
  const output: string[] = [...header]
  let used = header.join("\n").length

  for (const section of sections.sort((a, b) => a.priority - b.priority)) {
    const block: string[] = [`### ${section.title}`]
    for (const line of section.lines) {
      const normalized = line.replace(/\s+/g, " ").trim().toLowerCase()
      if (!normalized || seen.has(normalized)) continue
      const candidate = `- ${line.trim()}`
      if (used + candidate.length + 2 > sources.maxChars) continue
      seen.add(normalized)
      block.push(candidate)
      used += candidate.length + 2
    }
    if (block.length > 1) {
      output.push(block.join("\n"))
      used += block[0]!.length + 1
    }
    if (used >= sources.maxChars) break
  }

  if (used >= sources.maxChars) {
    output.push("…[memory context truncated to fit the configured limit]")
  }
  return output.join("\n\n")
}

function renderProfile(profile: Profile | null, scope: "global" | "project"): string[] {
  if (!profile) return []
  const lines: string[] = []
  const preferences = (profile.preferences ?? [])
    .filter((entry) => entry.confidence >= 0.6)
    .slice(0, scope === "project" ? 6 : 5)
  for (const preference of preferences) {
    lines.push(`${preference.statement} (confidence ${preference.confidence.toFixed(2)})`)
  }
  const tech = (profile.technical ?? []).filter((entry) => entry.count >= 2).slice(0, scope === "project" ? 6 : 5)
  if (tech.length) {
    lines.push(`Frequently works with: ${tech.map((entry) => entry.name).join(", ")}`)
  }
  const tools = (profile.tools ?? []).filter((entry) => entry.count >= 3).slice(0, 3)
  if (tools.length) {
    lines.push(`Frequent tools: ${tools.map((entry) => `${entry.name} (${entry.count})`).join(", ")}`)
  }
  const commands = (profile.workflow?.top_shell_commands ?? []).slice(0, 3)
  if (commands.length) {
    lines.push(`Frequent commands: ${commands.map((command) => `\`${command}\``).join(", ")}`)
  }
  return lines
}

function markdownLines(text: string, maxLines: number): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s*/, "").replace(/^[-*+]\s+/, "").trim())
    .filter((line) => line && !line.startsWith("<!--") && !/^[-*_]{3,}$/.test(line))
    .slice(0, maxLines)
}
