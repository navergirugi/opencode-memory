# OpenCode compatibility

This document records the OpenCode behavior and APIs this plugin relies on, what was verified, and what remains unverified. It was written against the official V2 documentation; no internal or undocumented API is used.

## Verified environment

| Item | Value |
| --- | --- |
| OpenCode CLI | `2.0.32` (macOS arm64) |
| `@opencode/plugin` | `2.1.2` |
| Documentation retrieved | 2026-10-22 |
| Test project | Temporary directory with `.opencode/plugins/memory/index.ts` |
| Server | `opencode serve --port 4199` with a live session |

Official sources:

- V2 docs index: <https://opencode.ai/v2/docs/>
- Plugin authoring: <https://opencode.ai/v2/docs/build/plugins>
- Plugin configuration: <https://opencode.ai/v2/docs/plugins>
- API reference: <https://opencode.ai/v2/docs/api>
- OpenAPI document: <https://opencode.ai/v2/openapi.json>
- Config schema: <https://opencode.ai/config.json>

## APIs used

| API | Use |
| --- | --- |
| `Plugin.define({ id, setup })` | Plugin entrypoint and lifecycle |
| `ctx.location` | Current `directory`, project `id`, and `canonical` path |
| `ctx.options` | Data directory and optional settings from `opencode.json(c)` |
| `ctx.session.list` | Poll recent sessions for the active project |
| `ctx.session.get` | Read session metadata and project identity |
| `ctx.session.context` | Read the active message context for a session |
| `ctx.session.hook("prompt")` | Capture user prompts before admission/compaction |
| `ctx.session.hook("context")` | Inject the prioritized memory block into outgoing model requests |
| `ctx.session.synthetic` | Show command output to the user |
| `ctx.tool.transform` | Register the `opencode_memory` tool |
| `ctx.tool.hook("execute.after")` | Capture completed and failed tool calls |
| `ctx.command.transform` | Register `/memory-*` commands |
| `ctx.event.subscribe` | Capture durable session events while connected |

Relevant type contracts, checked against `@opencode/plugin@2.1.2`:

- `Context.location: Location.Info` with `directory` and `project: { id, directory, canonical }`.
- `ToolHooks["execute.after"]` carries `tool`, `sessionID`, `messageID`, `id`, `input`, and either `status: "completed"` + `result` or `status: "error"` + `error`.
- `SessionPrompt` carries `sessionID`, `messageID`, `prompt` (`text`, `files`, `agents`, `skills`), optional `metadata`, and `delivery`.
- `SessionContext` carries `sessionID`, agent, model, `system`, `messages`, and request `options`.
- `CommandDefinition.execute` receives `{ sessionID, prompt, delivery }`.

## Verified behavior

### Local plugin loading

A directory under `.opencode/plugins/` loads when it contains `index.ts` at its root. The loader uses that file as the entrypoint.

```text
opencode plugin list
ID                       VERSION  SOURCE
opencode-memory.context  local    .../.opencode/plugins/memory/index.ts
```

The loader watched the re-exported files under `src/`, which confirms the entire module graph was loaded. A directory containing only `package.json` was not loaded in this version, so this repository also ships a root `index.ts`.

The publication docs show package exports as `"exports": { ".": "./src/index.ts" }`, which this package supports.

### Server, session, commands, and synthetic output

- `opencode serve` started and exposed `/api/*`.
- `GET /api/plugin` listed the built-in plugin set; location plugins activated when a session was created.
- After creating a session in the test project, `GET /api/command` returned:
  `memory-status`, `memory-doctor`, `memory-sync`, `memory-analyze`, `memory-setup`.
- `POST /api/session/{id}/command` with `{"name":"memory-status","text":""}` executed the command handler.
- Reading the session context showed the synthetic message:
  `OpenCode Memory status ... - Setup: not configured ... Next step: run setup ...`
- The plugin log contained only `OpenCode Memory is not configured`; there were no registration errors.

This verifies real OpenCode loading, `ctx.command.transform`, command dispatch, runtime initialization, status generation, and `ctx.session.synthetic`.

### Documented session context limitation

The API reference describes `session.context` as:

> Retrieve the active context messages for a session (all messages after the last compaction).

Source: <https://opencode.ai/v2/docs/api> (operation `session.context`).

The plugin therefore does not treat `session.context()` as a complete transcript. It captures prompts and tool results live and uses polling as a reconciliation path. History that only existed before the latest compaction can be missing.

### Events

`ctx.event.subscribe` is documented as a stream over the connected server's public events. It is not durable: events emitted while disconnected are not replayed. The plugin uses it as an enhancement, not as the only source, and caps concurrent event collection.

The tool event schema does not include the tool name, so tool events are skipped to avoid writing an `"unknown"` record that would win deduplication over the richer tool hook or context record.

## Not verified

- **Desktop GUI interaction.** The plugin was verified through the real OpenCode server/CLI and command API, not by visually operating the desktop app.
- **Model-driven tool invocation.** The local model provider returned HTTP 503 during the test, so the `opencode_memory` tool was registered but not invoked by a model.
- **GitHub.com network path.** Setup, auth, push, rebase, and conflict behavior were verified against local bare Git repositories with the explicit local-repository test flag. The same code path uses HTTPS/SSH for GitHub, but no real GitHub write occurred.
- **Authentication against GitHub.** Token detection, transient credential helper, absence from config/logs, and failure reporting were tested locally. No real token was used.
- **Windows and Linux.** Platform-specific data directories are implemented and unit tested; the live load test was macOS only.
- **npm publication.** The package has not been published.

## Version policy

The plugin targets the OpenCode V2 promise-based plugin API. It pins no OpenCode CLI version. The package dependency is `@opencode/plugin@^2.1.2`. Before publishing an update, re-run the load verification against the OpenCode version you target, because plugin API contracts can change between minor versions.

## Compatibility risks

1. **Pre-1.0 churn.** OpenCode V2 is evolving. Hook event fields and transform editor methods are the most likely to change.
2. **Compaction.** Collection gaps are structural, not a bug in this plugin. Live hooks reduce but do not eliminate them.
3. **Runtime location.** Background sync and analysis run inside the OpenCode server process. If OpenCode is not running, scheduled sync does not run; queued records remain safe and sync on next start.
4. **Multiple locations.** A plugin runtime exists per OpenCode location, while the data directory is per user/computer. Git work is serialized with process and `mkdir` locks, so multiple locations on one machine can share it. Do not point two machines at the same data directory; share through the Git remote instead.
