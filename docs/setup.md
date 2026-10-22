# Setup

This guide covers the private GitHub repository, authentication, first-time setup, and onboarding multiple developers and computers.

## 1. Create the private repository

1. Create an **empty private** repository on GitHub, for example `your-account/opencode-memory`.
2. Do not add a README, license, or `.gitignore`. The plugin scaffolds the repository.
3. Invite every developer who should share project context as a collaborator with **write** access. Developers only need access to their own memory files plus the shared project context; the repository itself is the access boundary.

The repository is the source of truth. It contains session history, profiles, project rules, checkpoints, and conflict-prone JSONL segments. Keep it private.

## 2. Authenticate

Choose one method. The plugin checks them in this order for HTTPS URLs:

1. `OPENCODE_MEMORY_GITHUB_TOKEN`
2. `GITHUB_TOKEN`
3. `GH_TOKEN`
4. `gh auth token`
5. Ambient Git credential helper
6. SSH agent/key (for `git@github.com:...` or `ssh://git@github.com/...` URLs)

Recommended:

```bash
gh auth login
```

For a fine-grained token, grant **Contents: Read and write** on the single memory repository. A classic token needs the `repo` scope. Pass the token to the OpenCode server process, not to a shell command that writes it to disk:

```bash
export OPENCODE_MEMORY_GITHUB_TOKEN=github_pat_...
```

Security rules enforced by the plugin:

- Credentials embedded in the repository URL are rejected.
- Tokens are never written to `config.json`, the memory repository, Git config, or logs.
- For tokens, Git receives a transient in-process credential helper through child-process environment variables only.
- `config.json` is written with mode `0600`; the data directory is created with mode `0700`.
- Setup runs `git push --dry-run` to verify write access before saving configuration.

If your organization uses SSO, authorize the token for the organization before setup.

## 3. Configure

In an OpenCode session for the project:

```text
/memory-setup https://github.com/you/opencode-memory.git alice "Alice" "Work MacBook" my-project
```

| Argument | Required | Notes |
| --- | --- | --- |
| Repository URL | yes | `https://github.com/owner/repo.git` or `git@github.com:owner/repo.git` |
| Developer ID | yes | Stable across all PCs: letters, digits, dot, underscore, hyphen; 1–64 chars; starts alphanumeric |
| Display name | no | Human-readable label in registry files |
| Device name | no | Label for this computer |
| Project ID | no | Stable alias; defaults to the normalized OpenCode project ID |

The same operation through the tool:

```json
{
  "action": "setup",
  "repo_url": "https://github.com/you/opencode-memory.git",
  "developer_id": "alice",
  "developer_name": "Alice",
  "device_name": "Work MacBook",
  "project_id": "my-project"
}
```

Setup writes:

```text
config/developers/<developer>.json
config/projects/<project>.json
projects/<project>/project.json
projects/<project>/conventions.md
projects/<project>/shared-context.md
developers/<developer>/preferences.md
histories/<project>/.gitkeep
sync/checkpoints/.gitkeep
.gitattributes
```

An empty remote is initialized; an existing remote is cloned. A non-empty directory that is not a Git repository is rejected rather than overwritten.

## 4. Verify

```text
/memory-doctor
/memory-status
```

Expected doctor checks:

```text
[ok] configuration
[ok] data-directory
[ok] local-repository
[ok] origin
[ok] authentication
[ok] read-access
[ok] write-access
[ok] local-queue
```

If setup fails, no configuration is saved. Fix the reported problem and run setup again. See [troubleshooting.md](troubleshooting.md).

## 5. Onboard another computer or developer

Each computer needs its own data directory and its own clone. Do not sync the data directory with Dropbox, iCloud, or a network share.

For a second computer for the same developer:

```text
/memory-setup https://github.com/you/opencode-memory.git alice "Alice" "Home PC"
```

The plugin creates a new device ID automatically and reuses the developer ID. Setup records the new device in `config/developers/alice.json`.

For another developer:

```text
/memory-setup https://github.com/you/opencode-memory.git bob "Bob" "Bob's laptop"
```

Both developers write to separate history directories:

```text
histories/<project>/<developer>/sessions/<session>.jsonl
```

Only the shared `projects/<project>/conventions.md` and `shared-context.md` are intentionally common. The analyzer never edits those files; it writes a proposal at `analysis/projects/<project>/shared-context.proposal.md` for human review.

## 6. Map projects

OpenCode identifies projects internally. The plugin maps that ID to a stable memory project ID:

```json
{
  "project_ids": {
    "oc_abc123": "my-project"
  }
}
```

If no mapping exists, the normalized OpenCode project ID is used. To use an explicit alias, pass `project_id` during setup or edit `project_ids` in `config.json`.

To collect sessions from every OpenCode project rather than only the active location, set:

```json
{
  "collect_all_projects": true
}
```

Leave it `false` for strict project separation.

## 7. Tune behavior

Settings live in `<dataDir>/config.json`. Plugin `options` can override them at load time.

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `sync_interval_seconds` | 300 | 30–86400 | Background Git sync interval |
| `scan_interval_seconds` | 60 | 15–3600 | Session polling interval |
| `analysis_interval_hours` | 24 | 1–720 | Minimum time between analyses |
| `context_max_chars` | 4000 | 0–20000 | Maximum injected context size; `0` disables injection |
| `paused` | false | — | Stop collection and scheduled sync |
| `collect_all_projects` | false | — | Collect sessions from all OpenCode projects |

Example:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-memory-context",
      "options": {
        "dataDir": "/Users/alice/Library/Application Support/opencode-memory",
        "sync_interval_seconds": 600,
        "analysis_interval_hours": 24,
        "context_max_chars": 3000
      }
    }
  ]
}
```

## 8. Daily analysis

The runtime checks whether analysis is due every 15 minutes. Analysis also runs at startup after the first sync. A run:

1. Syncs first, so the local repository includes teammates' records.
2. Reads new records after the per-scope checkpoint.
3. Updates the global developer profile and the project-scoped developer profile.
4. Writes a shared-context **proposal**; it never edits canonical project rules.
5. Commits and pushes the result.

If another device advanced the checkpoint while analysis was running, the stale run is discarded and the next run processes the new range. If analysis fails, the checkpoint is not advanced and the error is stored in `state/runtime.json`.

Force a run with `/memory-analyze`. The command intentionally ignores the daily interval; it still respects checkpoints and stale-write protection.

## 9. Profile inspection and optional deep analysis

Use `/memory-profile` to inspect the current global profile, project profile, explicit preferences, and optional deep profile. The command is read-only and shows confidence and a short evidence quote for inferred preferences.

The scheduled analyzer is local and does not call an LLM. If you want a richer, model-generated interpretation of your working style, run:

```text
/memory-deep-analyze
/memory-deep-analyze --no-messages
/memory-deep-analyze --model provider/model
```

The command sends a compact digest to the configured model, writes `developers/<developer>/deep-profile.md`, commits, and pushes. It includes the last 30 user messages by default; `--no-messages` analyzes profiles only. The `deep_analyze` tool action defaults to `include_messages: false`. The generated file is injected into future context at lower priority than project rules and explicit preferences, so review it and edit or delete it if it is wrong. The deep analysis request does not send tool outputs or file contents.

## 10. Uninstall or reset

- **Pause:** call the tool with `action: "pause"` (pause/resume have no slash commands), or set `paused: true`.
- **Stop loading the plugin:** remove it from `opencode.json(c)` or `.opencode/plugins`.
- **Reset this computer:** move the data directory aside, then run setup again. The private repository is not deleted; the new clone restores history.
- **Remove the repository:** delete it on GitHub. Local clones remain until you delete the data directory.

Never delete the private repository as a way to resolve a conflict; local commits can still be recovered from clones, but other devices may lose access to shared context.
