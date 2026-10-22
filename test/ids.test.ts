import { describe, expect, it } from "vitest"
import { assertMemoryId, compareCursor, isAfterCursor, normalizeProjectId, safeFileSegment, slugify } from "../src/ids.js"

describe("ids", () => {
  it("accepts stable ids and rejects path traversal", () => {
    expect(assertMemoryId("developer_id", "alice-01")).toBe("alice-01")
    expect(() => assertMemoryId("developer_id", "../etc/passwd")).toThrow()
    expect(() => assertMemoryId("developer_id", "a/b")).toThrow()
    expect(() => assertMemoryId("developer_id", "..")).toThrow()
    expect(() => assertMemoryId("developer_id", "")).toThrow()
  })

  it("encodes session ids without collisions", () => {
    const a = safeFileSegment("ses/one")
    const b = safeFileSegment("ses_one")
    expect(a).not.toBe(b)
    expect(a).not.toContain("/")
    expect(safeFileSegment("..")).not.toBe("..")
  })

  it("normalizes arbitrary OpenCode project ids", () => {
    expect(normalizeProjectId("94a48debb33af5c1ff4ffa7bcda8546af89f4a4e")).toBe("94a48debb33af5c1ff4ffa7bcda8546af89f4a4e")
    expect(normalizeProjectId("a/b")).toMatch(/^p-[a-f0-9]{16}$/)
    expect(normalizeProjectId("a/b")).toBe(normalizeProjectId("a/b"))
  })

  it("slugifies directory names", () => {
    expect(slugify("My Project!")).toBe("my-project")
    expect(slugify("***")).toBe("project")
  })

  it("compares cursor tuples", () => {
    const a = { collected_at: "2026-01-01T00:00:00.000Z", record_id: "a" }
    const b = { collected_at: "2026-01-01T00:00:00.000Z", record_id: "b" }
    expect(compareCursor(a, b)).toBeLessThan(0)
    expect(isAfterCursor(b, { last_collected_at: a.collected_at, last_record_ids: ["a"] })).toBe(true)
    expect(isAfterCursor(a, { last_collected_at: a.collected_at, last_record_ids: ["a"] })).toBe(false)
  })
})
