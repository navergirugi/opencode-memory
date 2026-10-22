# OpenCode Memory Context

Private, Git-backed developer memory for OpenCode.

This plugin collects OpenCode session history into a **private GitHub repository you own**, analyzes it incrementally once per day, and adds a small, project-aware context block to future model requests. It uses files and Git only: no database server, no hosted memory service, and no bundled model calls.

- **Package:** `opencode-memory-context` (not yet published to npm)
- **Plugin ID:** `opencode-memory.context`
- **Tool:** `opencode_memory`
- **Commands:** `/memory-setup`, `/memory-status`, `/memory-doctor`, `/memory-sync`, `/memory-analyze`

## What it does

1. **Collects** session metadata, user prompts, assistant text, tool calls, shell commands, compactions, and skills using official OpenCode V2 plugin APIs.
2. **Queues locally first**, then writes append-only JSONL segments into your private Git repository. Unsynced records survive restarts and offline periods.
3. **Syncs safely** with fetch → rebase → push. It never force-pushes, and it preserves unresolved conflicts instead of dropping local work.
4. **Analyzes incrementally** once per day. Checkpoints prevent duplicate work, and an older analysis cannot overwrite a newer profile. The analyzer is deterministic and heuristic; it does not call an LLM.
5. **Applies context** in this order: project rules → project shared context → your project profile → your explicit notes → your global preferences. Context is deduplicated and capped by `context_max_chars`.
6. **Keeps OpenCode usable** if setup, network, GitHub, or Git fails. Errors are reported in status and the local log; collection continues into the queue.

## Requirements

- OpenCode V2 (tested with `opencode v2.0.32`)
- `git` on `PATH`
- Node.js 22+ for development and tests (the OpenCode runtime supplies its own TypeScript loader)
- A **private** GitHub repository that your account can read and write
- Authentication through `gh auth login`, a Git credential helper, an SSH key, or a process environment token

## Install

### From source or a local checkout

```bash
git clone https://github.com/your-account/opencode-memory-context.git
cd opencode-memory-context
npm install
```

Point OpenCode at the checkout in `opencode.json(c)`:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-memory-context",
      "options": {}
    }
  ]
}
```

A local plugin directory is also supported. Create `.opencode/plugins/opencode-memory/index.ts` that re-exports the package entrypoint:

```ts
export { default } from "/absolute/path/to/opencode-memory-context/index.ts"
```

Once published, `opencode plugin add opencode-memory-context` installs it globally.

### Plugin options

Options are read from `ctx.options` and can also be stored in the plugin config file. The most important one is the data directory:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-memory-context",
      "options": {
        "dataDir": "/custom/path/opencode-memory"
      }
    }
  ]
}
```

The `OPENCODE_MEMORY_DATA_DIR` environment variable overrides the default data directory.

## First-time setup

In an OpenCode session for the project you want to track:

```text
/memory-setup https://github.com/you/your-private-memory.git alice "Alice" "Work MacBook" my-project
```

Arguments are: repository URL, developer ID, optional display name, optional device name, optional project ID.

Or call the tool directly:

```json
{
  "action": "setup",
  "repo_url": "https://github.com/you/your-private-memory.git",
  "developer_id": "alice",
  "developer_name": "Alice",
  "device_name": "Work MacBook"
}
```

Setup performs all of the following before it saves the configuration:

- Validates the repository URL (GitHub HTTPS or SSH; embedded credentials are rejected)
- Validates the developer ID, device ID, and project ID
- Clones the repository, or initializes an empty one
- Writes the repository scaffold and registry files
- Runs a dry-run push to confirm **write** access
- Saves `config.json` with mode `0600` in the data directory

Then verify:

```text
/memory-doctor
/memory-status
```

`/memory-doctor` checks configuration, local repository, origin, credentials, read access, and write access.

## Commands and tool actions

| Command | Tool action | Purpose |
| --- | --- | --- |
| `/memory-status` | `status` | Setup, IDs, queue, sync, analysis, and known limitations |
| `/memory-doctor` | `doctor` | Repository, credential, read, and write checks |
| `/memory-sync` | `sync` | Flush the queue, rebase, and push |
| `/memory-analyze` | `analyze` | Force an incremental analysis run |
| `/memory-setup` | `setup` | Configure the private repository |

The tool also accepts `pause`, `resume`, and `help`.

## Data locations

| Platform | Default data directory |
| --- | --- |
| macOS | `~/Library/Application Support/opencode-memory` |
| Linux | `$XDG_DATA_HOME/opencode-memory`, otherwise `~/.local/share/opencode-memory` |
| Windows | `%APPDATA%\opencode-memory` |

Inside the data directory:

```text
config.json             # IDs and repository URL, mode 0600
repo/                   # clone of your private memory repository
queue/                  # append-only JSONL waiting to enter the repository
state/runtime.json      # sync/analysis status
state/locks/            # cross-process locks
conflicts/<timestamp>/  # preserved conflict snapshots
logs/opencode-memory.log
```

The repository layout is documented in [docs/architecture.md](docs/architecture.md).

## Privacy and security

- **Private repository only.** Setup validates GitHub URLs and checks write access.
- **Tokens are never stored** in `config.json`, the memory repository, or logs. If a token is present in the environment, it is passed only through a transient child-process credential helper.
- **Best-effort masking** of API keys, GitHub tokens, JWTs, private keys, URL credentials, secret assignments, and home-directory paths before records are written. Masking is a safety net, not a guarantee; review what you commit.
- **No LLM calls** are made by this plugin. Analysis is local and deterministic.
- **Individual inference is never promoted to team rules.** Candidate team rules are written only to `shared-context.proposal.md`; canonical project files are never edited by the analyzer.
- **Private data is not part of the npm package.** The package ships source, docs, README, and license only.

See [docs/setup.md](docs/setup.md) for authentication choices and team onboarding.

## How context is applied

For each model request, the plugin reads the current project and injects one system block:

1. `projects/<project>/conventions.md` — authoritative team rules
2. `projects/<project>/shared-context.md` — reviewed shared context
3. `projects/<project>/developers/<developer>/profile.json` — your inferred project profile
4. `developers/<developer>/preferences.md` — your explicit notes
5. `developers/<developer>/profile.json` — your inferred global preferences

Project rules win over personal preferences. Duplicate lines are removed, and the block is truncated to `context_max_chars` (default `4000`). A session from another project never receives this project's context.

## Known limitations

- `ctx.session.context()` returns **only messages after the latest compaction**, as documented by OpenCode. Live prompt and tool hooks capture new work, but conversation history that existed only before a compaction may be absent.
- Event subscriptions are volatile. Events missed while disconnected are not replayed; periodic session polling reconciles what the context API still exposes.
- Tool event payloads do not include the tool name, so tool events are deliberately ignored to avoid writing an `"unknown"` record that would win deduplication over the richer tool hook or context record.
- Analysis is heuristic. Profiles are hints with evidence and confidence, not facts.
- Git conflicts in non-JSONL files are preserved, not auto-resolved. Resolve them in the private repository and sync again.
- One memory repository per data directory. Separate PCs and developers need their own local clone; do not share a data directory through a file sync service.

## Development

```bash
npm install
npm test           # 48 tests
npm run typecheck
```

The test suite covers collection and dedupe, redaction, config/permissions, store corruption, context priority, incremental analysis and stale writes, Git union merges across devices, push rejection and retry, conflict preservation, offline recovery, setup validation, and an end-to-end runtime flow.

Verification details and API references are in [docs/opencode-compatibility.md](docs/opencode-compatibility.md). More documentation:

- [docs/setup.md](docs/setup.md)
- [docs/troubleshooting.md](docs/troubleshooting.md)
- [docs/architecture.md](docs/architecture.md)

## License

MIT

## Status

Implemented and covered by automated tests. Real loading was verified with OpenCode `v2.0.32` and `@opencode/plugin` `2.1.2`: the plugin registered, commands appeared after a session was created, and `/memory-status` produced a synthetic status message. Publishing to npm and using a real GitHub private repository require the owner's credentials and were not performed.
