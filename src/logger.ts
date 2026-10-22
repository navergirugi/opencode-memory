import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { redactText } from "./redact.js"

type Level = "debug" | "info" | "warn" | "error"

const MAX_LOG_BYTES = 5 * 1024 * 1024

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
  file(): string
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '"[unserializable]"'
  }
}

export function createLogger(dataDir: string, options: { debug?: boolean; echo?: boolean } = {}): Logger {
  const file = join(dataDir, "logs", "opencode-memory.log")
  const debugEnabled = options.debug ?? process.env.OPENCODE_MEMORY_DEBUG === "1"
  const echo = options.echo ?? true

  const write = (level: Level, message: string, context?: Record<string, unknown>) => {
    if (level === "debug" && !debugEnabled) return
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redactText(message, 2_000)}${
      context ? ` ${redactText(safeStringify(context), 4_000)}` : ""
    }\n`
    try {
      mkdirSync(dirname(file), { recursive: true })
      if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
        renameSync(file, `${file}.1`)
      }
      appendFileSync(file, line, { encoding: "utf8", mode: 0o600 })
    } catch {
      // Logging must never break OpenCode.
    }
    if (echo && (level === "warn" || level === "error")) {
      console.error(`[opencode-memory] ${redactText(message, 2_000)}`)
    }
  }

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
    file: () => file,
  }
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  file: () => "",
}
