import { describe, expect, it } from "vitest"
import { createConfigFromSetup, defaultDataDir, normalizeConfig, validateRepoUrl } from "../src/config.js"

describe("config", () => {
  it("normalizes GitHub HTTPS and SSH URLs", () => {
    expect(validateRepoUrl("https://github.com/owner/repo")).toBe("https://github.com/owner/repo.git")
    expect(validateRepoUrl("git@github.com:owner/repo.git")).toBe("git@github.com:owner/repo.git")
    expect(validateRepoUrl("ssh://git@github.com/owner/repo")).toBe("ssh://git@github.com/owner/repo.git")
  })

  it("rejects credentials, non-GitHub hosts, and whitespace", () => {
    expect(() => validateRepoUrl("https://user:pass@github.com/o/r")).toThrow(/credentials/i)
    expect(() => validateRepoUrl("https://gitlab.com/o/r")).toThrow(/github/i)
    expect(() => validateRepoUrl("not a url")).toThrow()
  })

  it("creates a complete config and clamps intervals", () => {
    const config = createConfigFromSetup({
      repoUrl: "https://github.com/owner/repo",
      developerId: "alice",
      deviceId: "dev_123",
      opencodeProjectId: "abc",
      projectId: "project-a",
      options: { sync_interval_seconds: 1, analysis_interval_hours: 9999, context_max_chars: 0 },
    })
    expect(config.repo_url).toBe("https://github.com/owner/repo.git")
    expect(config.sync_interval_seconds).toBe(30)
    expect(config.analysis_interval_hours).toBe(24 * 30)
    expect(config.context_max_chars).toBe(0)
    expect(config.project_ids).toEqual({ abc: "project-a" })
    expect(config.setup_completed_at).toBeTruthy()
  })

  it("rejects invalid developer ids", () => {
    expect(() =>
      normalizeConfig({ repo_url: "https://github.com/o/r", developer_id: "../x", device_id: "dev_1" }, { dataDir: "" }),
    ).toThrow()
  })

  it("selects a platform data directory", () => {
    expect(defaultDataDir({} as NodeJS.ProcessEnv, "darwin")).toContain("opencode-memory")
    expect(defaultDataDir({ XDG_DATA_HOME: "/tmp/xdg" } as NodeJS.ProcessEnv, "linux")).toBe("/tmp/xdg/opencode-memory")
    expect(defaultDataDir({ OPENCODE_MEMORY_DATA_DIR: "/tmp/custom" } as NodeJS.ProcessEnv, "linux")).toBe("/tmp/custom")
  })
})
