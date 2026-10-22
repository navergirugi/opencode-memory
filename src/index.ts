import { Plugin } from "@opencode/plugin"
import { MemoryRuntime, helpText } from "./runtime.js"

const TOOL_INPUT = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["status", "setup", "sync", "analyze", "doctor", "pause", "resume", "help"],
      description: "The memory operation to perform.",
    },
    repo_url: {
      type: "string",
      description: "Private GitHub repository URL. Required for action=setup.",
    },
    developer_id: {
      type: "string",
      description: "Stable developer identifier (letters, digits, dot, underscore, hyphen). Required for action=setup.",
    },
    developer_name: { type: "string", description: "Optional display name." },
    device_name: { type: "string", description: "Optional name for this computer." },
    project_id: { type: "string", description: "Optional project identifier override for this project." },
  },
  required: ["action"],
  additionalProperties: false,
} as const

export default Plugin.define({
  id: "opencode-memory.context",
  async setup(ctx) {
    const runtime = new MemoryRuntime(ctx, ctx.options as Record<string, unknown>)
    await runtime.init(ctx.options as Record<string, unknown>)

    try {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "opencode_memory",
          description:
            "Inspect, configure, sync, or analyze the user's private OpenCode Memory repository. Use action=status for setup and sync state.",
          input: TOOL_INPUT,
          execute: async (input) => {
            const output = await runtime.handleTool((input ?? {}) as Record<string, unknown>)
            return { content: output }
          },
        })
      })
    } catch (error) {
      runtime.log.error("Could not register the memory tool", { error: String(error) })
    }

    try {
      await ctx.command.transform((editor) => {
        const commands: { name: string; description: string; action: string }[] = [
          { name: "memory-status", description: "Show OpenCode Memory setup, sync, queue, and analysis status", action: "status" },
          { name: "memory-doctor", description: "Verify the memory repository and credentials", action: "doctor" },
          { name: "memory-sync", description: "Flush the local queue, rebase, and push memory records", action: "sync" },
          { name: "memory-analyze", description: "Run the incremental memory analyzer now", action: "analyze" },
          { name: "memory-setup", description: "Configure the private GitHub memory repository", action: "setup" },
        ]
        for (const command of commands) {
          editor.add({
            name: command.name,
            description: command.description,
            execute: async ({ sessionID, prompt }) => {
              const args = (prompt.text ?? "").trim()
              const input: Record<string, unknown> = { action: command.action }
              if (command.action === "setup" && args) {
                const [repoURL, developerID, developerName, deviceName, projectID] = args.split(/\s+/)
                if (repoURL) input.repo_url = repoURL
                if (developerID) input.developer_id = developerID
                if (developerName) input.developer_name = developerName
                if (deviceName) input.device_name = deviceName
                if (projectID) input.project_id = projectID
              }
              const output =
                command.action === "setup" && !args
                  ? `OpenCode Memory setup\n\nRun /memory-setup <repo-url> <developer-id> [developer-name] [device-name] [project-id]\n\n${helpText()}`
                  : await runtime.handleTool(input)
              await ctx.session.synthetic({ sessionID, text: output, description: "OpenCode Memory" }).catch((error: unknown) => {
                runtime.log.warn("Could not display memory command output", { error: String(error) })
              })
            },
          })
        }
      })
    } catch (error) {
      runtime.log.error("Could not register memory commands", { error: String(error) })
    }

    try {
      await ctx.session.hook("prompt", (event) => {
        void runtime.onPrompt(event).catch(() => undefined)
      })
    } catch (error) {
      runtime.log.warn("Could not register the prompt hook", { error: String(error) })
    }

    try {
      await ctx.tool.hook("execute.after", (event) => {
        void runtime.onTool(event).catch(() => undefined)
      })
    } catch (error) {
      runtime.log.warn("Could not register the tool hook", { error: String(error) })
    }

    try {
      await ctx.session.hook("context", async (event) => {
        await runtime.applyContext(event)
      })
    } catch (error) {
      runtime.log.warn("Could not register the context hook", { error: String(error) })
    }

    return async () => {
      await runtime.shutdown()
    }
  },
})
