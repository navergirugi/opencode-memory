import { createHash, randomUUID } from "node:crypto"

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const RESERVED = new Set(["", ".", "..", "con", "prn", "aux", "nul"])

export class InvalidIdError extends Error {
  constructor(label: string, value: string, hint: string) {
    super(`Invalid ${label} "${value}". ${hint}`)
    this.name = "InvalidIdError"
  }
}

/** Validate a user-facing identifier used as a path segment. */
export function assertMemoryId(label: string, value: string): string {
  const trimmed = value.trim()
  if (!ID_RE.test(trimmed) || RESERVED.has(trimmed.toLowerCase())) {
    throw new InvalidIdError(
      label,
      value,
      "Use 1-64 characters: letters, digits, dot, underscore or hyphen; start with a letter or digit.",
    )
  }
  return trimmed
}

export function shortHash(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length)
}

/** Stabilize an arbitrary OpenCode project ID for use in a directory name. */
export function normalizeProjectId(value: string): string {
  if (ID_RE.test(value) && !RESERVED.has(value.toLowerCase())) return value
  return `p-${shortHash(value, 16)}`
}

/** Build a readable slug from a project directory name. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 48)
  return slug || "project"
}

/**
 * Encode a possibly hostile session ID as a single safe file name.
 * A hash suffix keeps distinct IDs distinct after replacement.
 */
export function safeFileSegment(value: string): string {
  const replaced = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80)
  const base = replaced === "" || RESERVED.has(replaced.toLowerCase()) ? "x" : replaced
  return `${base}-${shortHash(value, 10)}`
}

export function newDeviceId(): string {
  return `dev_${randomUUID()}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function toIso(value: number | string | undefined): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return nowIso()
}

/** Compare two (collected_at, record_id) cursor positions. */
export function compareCursor(
  a: { collected_at: string; record_id: string },
  b: { collected_at: string; record_id: string },
): number {
  if (a.collected_at < b.collected_at) return -1
  if (a.collected_at > b.collected_at) return 1
  if (a.record_id < b.record_id) return -1
  if (a.record_id > b.record_id) return 1
  return 0
}

export function isAfterCursor(
  record: { collected_at: string; record_id: string },
  cursor: { last_collected_at: string; last_record_ids: readonly string[] } | undefined,
): boolean {
  if (!cursor || !cursor.last_collected_at) return true
  if (record.collected_at > cursor.last_collected_at) return true
  if (record.collected_at < cursor.last_collected_at) return false
  return !cursor.last_record_ids.includes(record.record_id)
}
