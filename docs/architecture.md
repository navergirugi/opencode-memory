# Architecture

## Goals and constraints

The plugin is a private, multi-developer, multi-machine memory layer built on files and Git:

- No database server
- Append-only session segments
- Deduplication by original OpenCode session/message/tool IDs
- Safe incremental Git sync without force-push
- Daily incremental analysis with checkpoints and stale-write protection
- Strict separation of project-shared context, per-project personal profiles, and global personal profiles
- OpenCode remains usable when the plugin, network, GitHub, or Git fails

## Components

```text
src/index.ts        Plugin.define entrypoint; registers tool, commands, hooks
src/runtime.ts      Lifecycle, timers, sync/analysis orchestration, context injection
src/collector.ts    Converts sessions/messages/events/prompts/tools into records
src/store.ts        JSONL repository store, local queue, dedupe, quarantine
src/git.ts          Clone/init, auth, commit, fetch/rebase/push, conflicts, locks
src/analyze.ts      Incremental analyzer, checkpoints, stale guard, proposals
src/context.ts      Prioritized, deduplicated, length-limited context builder
src/config.ts       Validation, data directory, config permissions
src/redact.ts       Best-effort secret/path masking
src/setup.ts        Read/write validation and initial repository scaffold
src/status.ts       Status, doctor, runtime state
src/ids.ts          ID validation, path-safe names, cursor comparison
```

## Data flow

```text
OpenCode session
  ├─ session.context() polling ─┐
  ├─ session.hook("prompt") ────┤
  ├─ tool.hook("execute.after") ├─> Collector ─> LocalQueue (dataDir/queue)
  └─ event.subscribe ───────────┘                         │
                                                          v
                                          RecordStore (repo/histories/...)
                                                          │
                                            commit + fetch/rebase/push
                                                          │
                                                          v
                                             private GitHub repository
                                                          │
                                              daily incremental analysis
                                                          │
                                                          v
                                      profiles + shared-context proposal
                                                          │
                                          context builder (priority + limit)
                                                          │
                                                          v
                                    ctx.session.hook("context") -> model request
```

## Collection

### Sources

| Source | What it captures | Why |
| --- | --- | --- |
| `ctx.session.context()` | Session metadata and active messages | Reconciles history and captures messages not seen live |
| `session.hook("prompt")` | User prompt at admission | Survives compaction and captures work before it can be summarized away |
| `tool.hook("execute.after")` | Tool name, input, result/error | Richer than tool events, which omit the name |
| `ctx.event.subscribe` | Session lifecycle, assistant text/reasoning, shell, compaction, synthetic, skills | Durable while connected; fills gaps between polls |
| `ctx.location` | Project identity and directory | Project separation |

### Record shape

```json
{
  "schema_version": 1,
  "record_id": "ses_...:msg_...:user",
  "kind": "message.user",
  "project_id": "my-project",
  "developer_id": "alice",
  "device_id": "dev_...",
  "session_id": "ses_...",
  "message_id": "msg_...",
  "event": "message.user",
  "created_at": "2026-01-01T00:00:00.000Z",
  "collected_at": "2026-01-01T00:00:01.000Z",
  "source": "api",
  "payload": { "text": "..." }
}
```

Kinds: `session.meta`, `message.user`, `message.assistant.text`, `message.assistant.reasoning`, `message.assistant.tool`, `message.shell`, `message.synthetic`, `message.system`, `message.skill`, `message.compaction`.

### Deduplication keys

| Kind | Key |
| --- | --- |
| Session metadata from API | `<session>:meta:<updated>` |
| Session created event | `<session>:meta:created` |
| User message | `<session>:<message>:user` |
| Assistant text/reasoning | `<session>:<message>:text:<ordinal>` / `:reasoning:<ordinal>` |
| Tool call | `<session>:<message>:tool:<call-id>` |
| Shell | `<session>:<message>:shell` |
| Compaction | `<session>:<message>:compaction` or `<session>:compaction:<timestamp>` |
| Synthetic/skill | `<session>:synthetic:<event>` / `<session>:skill:<event>` |

The local queue deduplicates within its files; the repository store deduplicates by `record_id` before appending. Because keys are derived from OpenCode IDs rather than collection time, polling, prompt hooks, tool hooks, and events converge to one record.

Tool events are skipped deliberately: they do not carry the tool name, and writing an `"unknown"` record first would make the richer tool-hook/context record a duplicate.

### Append-only storage

```text
histories/<project>/<developer>/sessions/<safe-session-id>.jsonl
```

Each line is one complete JSON record. Appends are single-file `appendFile` operations; partial final lines are ignored on read. A `.gitattributes` rule uses `merge=union` for `histories/**/*.jsonl`, so two devices appending different records to the same session file merge without a conflict. Record deduplication on read handles any duplication.

`safeFileSegment` replaces unsafe characters and appends a hash suffix, so distinct session IDs cannot collide and path traversal is impossible.

## Git synchronization

```text
withRepoLock(dataDir, "sync")
  ensureRepository()
  flushQueue()               # queue -> JSONL store
  commitAll()                # local commit if dirty
  syncRepository()
    fetch origin <branch>
    rebase origin/<branch>
    push HEAD:refs/heads/<branch>   (no --force)
    on rejection: sleep 1s, 2s, 4s; fetch + rebase; retry (max 3)
```

- `fetchRemote` treats a missing remote branch as an empty remote.
- Conflicts: copy conflicted files to `<dataDir>/conflicts/<timestamp>/`, write a manifest, abort the rebase, throw `GitConflictError`. Local commits are preserved.
- The push retry loop matches non-fast-forward/rejected errors. Credential/policy denials fail immediately.
- A process-local promise chain plus a `mkdir` lock under `state/locks` serialize Git work. Stale locks older than 10 minutes are reclaimed. The wait timeout is 30 seconds.
- A dirty or ahead repository is reported by status even if sync cannot run.

## Analysis

### Scope separation

| Scope | Output |
| --- | --- |
| Global developer | `developers/<developer>/profile.json` and `analysis/developers/<developer>/global.json` |
| Project + developer | `projects/<project>/developers/<developer>/profile.json` and `analysis/projects/<project>/developers/<developer>.json` |
| Global deep profile (opt-in) | `developers/<developer>/deep-profile.md` |
| Project shared | `projects/<project>/conventions.md`, `shared-context.md` (read-only to the analyzer) |
| Proposal | `analysis/projects/<project>/shared-context.proposal.md` |

A project profile is never used for another project. The shared proposal is never written into canonical team rules.

### Incremental algorithm

1. Read records for the scope from the repository.
2. Read the checkpoint at `sync/checkpoints/<developer>/<scope>.json`.
3. Filter records after `(last_collected_at, last_record_ids)`.
4. Extract tools, languages, technical signals, preferences, shell commands, activity hours, and counts.
5. Merge with the previous profile (preferences keep evidence and confidence; counts accumulate).
6. Re-read the checkpoint. If its version changed, throw `StaleCheckpointError` and write nothing.
7. Write profiles atomically (`write temp` → `rename`), but only if the new cursor is not older than the existing profile cursor.
8. Write the checkpoint with an incremented version.
9. Commit and push.

This gives three protections:

- **No duplicate analysis:** the checkpoint filters already-processed records.
- **No stale overwrite:** `shouldWriteProfile` compares cursor positions before writing.
- **No lost work on race:** a checkpoint version change aborts the stale run.

### Heuristic extraction

The analyzer is deterministic and local. It does not call an LLM. Preferences are sentences containing cues such as `always`, `never`, `prefer`, `avoid`, `instead of`, `make sure`, `don't`, and Korean equivalents (`항상`, `절대`, `선호`, etc.). Each preference stores:

- a stable ID derived from normalized text
- the statement (redacted and truncated)
- confidence (`0.65` explicit, increases with repeated evidence, capped at `0.9`)
- evidence record IDs and quotes
- origin (`explicit`, `repeated`, `inferred`)

Technical signals come from a dictionary of languages, frameworks, databases, infrastructure, cloud, testing, and runtimes, plus filename extensions. Shell commands are summarized to the first four tokens and redacted. Commands are read from both `message.shell` records and `message.assistant.tool` records whose tool name is `shell`.

Log-like lines (for example `npm error`, `Error:`, stack traces, `ECONNREFUSED`, and 403/404 messages) are excluded before preference extraction. The whole source line is skipped so a trailing fragment such as `Never retry this.` is not learned as a preference.

### Optional deep analysis

`/memory-deep-analyze` and the `deep_analyze` tool action are explicit opt-in operations. They do not run on a schedule. The runtime builds a prompt from:

- `developers/<developer>/preferences.md`
- the global profile
- the current project profile
- optionally, the last 30 user messages (truncated, redacted, and capped)

It calls `ctx.generate.text` with the default model or a `provider/model` supplied by the user, writes `developers/<developer>/deep-profile.md`, and then uses the normal safe commit/push path. The file is a hint for future model requests, not an authoritative rule. It is injected at lower priority than project rules and explicit preferences.

### Shared-context proposal

The proposal contains stack signals, languages, repeated commands, and **candidate** team rules below the explicit-confidence threshold, plus a review checklist. The analyzer never edits `conventions.md` or `shared-context.md`.

## Context injection

`buildContextText` reads, in priority order:

1. Project conventions (`projects/<project>/conventions.md`)
2. Project shared context (`projects/<project>/shared-context.md`)
3. Project personal profile (`projects/<project>/developers/<developer>/profile.json`)
4. Explicit personal notes (`developers/<developer>/preferences.md`)
5. Optional LLM deep profile (`developers/<developer>/deep-profile.md`)
6. Global personal profile (`developers/<developer>/profile.json`)

Behavior:

- Sections are sorted by priority.
- Lines are normalized and deduplicated case-insensitively.
- Only preferences with confidence ≥ `0.6` and technical signals with count ≥ `2` are considered.
- The block is capped at `context_max_chars`; if truncated, a marker is appended.
- The block starts with `<!-- opencode-memory:context:v1 -->` so it can be detected and not injected twice into one request.
- The current session's project is resolved from `ctx.session.get`. If it differs from the location project and `collect_all_projects` is false, no context is added.
- Context is cached per project for 30 seconds.

The injected text explicitly tells the model that project rules take precedence and that inferred items are hints, not facts.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| OpenCode not configured | Plugin stays loaded; status says not configured; no collection |
| Network/GitHub offline | Queue grows; sync error stored; retry later |
| Git push rejected | Fetch/rebase/retry bounded; local commits preserved |
| Non-JSONL conflict | Snapshot under `conflicts/`; rebase aborted; local work preserved |
| Analysis race | `StaleCheckpointError`; nothing overwritten |
| Corrupt queue line | Quarantined; valid lines continue |
| Corrupt history line | Ignored on read and logged |
| Corrupt config | Configuration error; plugin does not crash |
| Event stream ends | Logged; polling continues |
| Context build fails | Debug log; request proceeds without context |
| Deep analysis model call fails | Error returned to the caller; no deep-profile file is written |
| Git lock contention | Waits up to 30s, then reports a retryable error |

## Security boundaries

- Secrets are masked before persistence, including provider tokens, GitHub tokens, JWTs, private keys, URL credentials, assignments like `password=`, environment-style secrets, and home-directory paths.
- Tool inputs are recursively redacted; sensitive keys (`token`, `secret`, `password`, `authorization`, etc.) are replaced wholesale.
- Tokens are passed only through the child process environment and a transient credential helper. They are not written to disk.
- File paths are validated against `..` escapes; IDs used as path segments are validated or hashed.
- The memory repository is expected to be private. The plugin cannot enforce GitHub repository visibility; it validates the URL and write access, and documentation instructs the owner to keep it private.

## Design deviations from a central registry

The original instructions allowed either central `developers.json`/`projects.json` files or per-developer/per-project files. This implementation uses **one JSON file per developer and per project**, plus per-developer project profiles. Reason: it substantially reduces Git conflicts when multiple developers and PCs write concurrently. Documentation and repository scaffolding describe this layout.

## Known structural limitations

- `session.context()` is the post-compaction active context, not an unbounded transcript.
- Event subscriptions are not durable; missed events are not replayed.
- Analysis runs inside the OpenCode server process. If OpenCode is not running, scheduled analysis does not run.
- Heuristic profiles can be wrong or stale; they are presented with confidence and evidence.
- One repository per data directory. Do not share a data directory between machines or sync it with a file-sync service.
