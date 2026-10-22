import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Profile } from "./types.js"

export interface ProfilePaths {
  global: string
  project?: string
  explicit: string
  deep: string
}

export function profilePaths(repoDir: string, developerID: string, projectID?: string): ProfilePaths {
  const base = join(repoDir, "developers", developerID)
  return {
    global: join(base, "profile.json"),
    project: projectID ? join(repoDir, "projects", projectID, "developers", developerID, "profile.json") : undefined,
    explicit: join(base, "preferences.md"),
    deep: join(base, "deep-profile.md"),
  }
}

export async function readOptionalText(path: string | undefined): Promise<string> {
  if (!path || !existsSync(path)) return ""
  return readFile(path, "utf8").catch(() => "")
}

export async function readOptionalProfile(path: string | undefined): Promise<Profile | null> {
  const text = await readOptionalText(path)
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as Profile
  } catch {
    return null
  }
}

export interface ProfileReportInput {
  developerID: string
  developerName?: string
  projectID?: string
  projectName?: string
  globalProfile: Profile | null
  projectProfile: Profile | null
  explicitPreferences: string
  deepProfile: string
}

export function renderProfileReport(input: ProfileReportInput): string {
  const lines: string[] = [
    "OpenCode Memory developer profile",
    `- Developer: ${input.developerID}${input.developerName ? ` (${input.developerName})` : ""}`,
    `- Project: ${input.projectName ?? input.projectID ?? "unset"}`,
  ]

  if (!input.globalProfile && !input.projectProfile) {
    lines.push(
      "",
      "No analyzed profile yet. Send a few real messages, then run /memory-analyze or wait for the daily analysis.",
    )
  } else {
    if (input.globalProfile) lines.push(...renderProfileSection(input.globalProfile, "Global profile"))
    if (input.projectProfile) lines.push(...renderProfileSection(input.projectProfile, "Project profile"))
  }

  const explicit = input.explicitPreferences.trim()
  lines.push("", "### Explicit preferences (authoritative)")
  if (explicit) {
    lines.push(explicit)
  } else {
    lines.push("- (none)")
  }

  const deep = input.deepProfile.trim()
  if (deep) {
    lines.push("", "### Deep profile (LLM-generated, hints only)", deep)
  }

  lines.push(
    "",
    "These lines are injected into model requests, capped by context_max_chars. Project rules take precedence; inferred items are hints, not facts.",
    "Regenerate the inferred profile with /memory-analyze. Generate an optional LLM profile with /memory-deep-analyze.",
  )
  return lines.join("\n")
}

function renderProfileSection(profile: Profile, label: string): string[] {
  const stats = profile.stats
  const lines: string[] = [
    "",
    `### ${label}`,
    `- Generated: ${profile.generated_at}`,
    `- Sessions: ${stats.sessions}; records: ${stats.records}; user messages: ${stats.user_messages}; tool calls: ${stats.tool_calls}`,
  ]
  if (stats.active_utc_hours.length) {
    lines.push(`- Active UTC hours: ${stats.active_utc_hours.join(", ")}`)
  }
  if (profile.tools.length) {
    lines.push(`- Tools: ${profile.tools.slice(0, 8).map((entry) => `${entry.name} (${entry.count})`).join(", ")}`)
  }
  if (profile.languages.length) {
    lines.push(`- Languages: ${profile.languages.slice(0, 8).map((entry) => `${entry.name} (${entry.count})`).join(", ")}`)
  }
  if (profile.technical.length) {
    lines.push(
      `- Technical: ${profile.technical
        .slice(0, 8)
        .map((entry) => `${entry.name} (${entry.category}, ${entry.count})`)
        .join(", ")}`,
    )
  }
  const commands = profile.workflow.top_shell_commands.slice(0, 5)
  lines.push(
    `- Workflow: average user message ${profile.workflow.average_user_message_chars} chars${commands.length ? `; top commands: ${commands.join(", ")}` : ""}`,
  )
  if (profile.preferences.length) {
    lines.push("- Inferred preferences:")
    for (const preference of profile.preferences.slice(0, 8)) {
      const evidence = preference.evidence[0]?.quote
      lines.push(
        `  - ${preference.statement} (confidence ${preference.confidence.toFixed(2)}, ${preference.origin}${evidence ? `; evidence: "${truncate(evidence, 140)}"` : ""})`,
      )
    }
  } else {
    lines.push("- Inferred preferences: none yet")
  }
  return lines
}

export function renderProfileForPrompt(profile: Profile | null, label: string): string[] {
  if (!profile) return [`${label}: (not available)`]
  const lines = [
    `${label}:`,
    `- generated_at: ${profile.generated_at}`,
    `- sessions: ${profile.stats.sessions}; records: ${profile.stats.records}; user_messages: ${profile.stats.user_messages}; tool_calls: ${profile.stats.tool_calls}`,
  ]
  if (profile.tools.length) {
    lines.push(`- tools: ${profile.tools.slice(0, 8).map((entry) => `${entry.name}(${entry.count})`).join(", ")}`)
  }
  if (profile.languages.length) {
    lines.push(`- languages: ${profile.languages.slice(0, 8).map((entry) => `${entry.name}(${entry.count})`).join(", ")}`)
  }
  if (profile.technical.length) {
    lines.push(`- technical: ${profile.technical.slice(0, 8).map((entry) => `${entry.name}(${entry.category},${entry.count})`).join(", ")}`)
  }
  if (profile.workflow.top_shell_commands.length) {
    lines.push(`- top_commands: ${profile.workflow.top_shell_commands.slice(0, 8).join(", ")}`)
  }
  lines.push(`- average_user_message_chars: ${profile.workflow.average_user_message_chars}`)
  for (const preference of profile.preferences.slice(0, 10)) {
    const evidence = preference.evidence[0]?.quote
    lines.push(
      `- preference: ${preference.statement} (confidence ${preference.confidence.toFixed(2)}, ${preference.origin}${evidence ? `, evidence: ${truncate(evidence, 160)}` : ""})`,
    )
  }
  return lines
}

export interface DeepAnalysisPromptInput {
  developerID: string
  projectID?: string
  projectName?: string
  explicitPreferences: string
  globalProfile: Profile | null
  projectProfile: Profile | null
  userMessages?: string[]
}

export function buildDeepAnalysisPrompt(input: DeepAnalysisPromptInput): string {
  const lines = [
    "You are analyzing a software developer's working style from OpenCode memory data.",
    "",
    "Rules:",
    "- Base every statement on the data below. Do not invent facts.",
    "- Separate explicit preferences from inferred evidence.",
    "- Treat inferred items as hints, not facts.",
    "- Focus on how an AI coding assistant should adapt its answers.",
    "- Do not include secrets, tokens, credentials, or raw file contents.",
    "- Output Markdown with these sections: Communication style, Technical focus, Workflow, Strengths, Blind spots, Instructions for AI assistants.",
    "- Keep the result under 1200 words.",
    "",
    `Developer: ${input.developerID}`,
    `Project: ${input.projectName ?? input.projectID ?? "unset"}`,
    "",
    "Explicit preferences (user-maintained, authoritative):",
    input.explicitPreferences.trim() || "(none)",
    "",
    ...renderProfileForPrompt(input.globalProfile, "Global profile"),
    "",
    ...renderProfileForPrompt(input.projectProfile, "Project profile"),
  ]

  if (input.userMessages?.length) {
    lines.push("", "Recent user messages (optional context; truncated and redacted):")
    for (const message of input.userMessages.slice(-30)) {
      lines.push(`- ${truncate(message.replace(/\s+/g, " ").trim(), 500)}`)
    }
  }

  lines.push("", "Return only the Markdown profile.")
  return lines.join("\n")
}

export async function writeDeepProfile(
  repoDir: string,
  developerID: string,
  text: string,
  generatedAt = new Date().toISOString(),
): Promise<string> {
  const path = profilePaths(repoDir, developerID).deep
  const body = [
    "<!-- opencode-memory:deep-profile:v1 -->",
    `<!-- generated ${generatedAt} by OpenCode Memory deep analysis; LLM-generated; edit or delete this file. -->`,
    "",
    text.trim(),
    "",
  ].join("\n")
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, "utf8")
  return path
}

function truncate(value: string, max: number): string {
  const text = value.trim()
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
