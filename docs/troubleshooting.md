# Troubleshooting

Start with:

```text
/memory-status
/memory-doctor
```

The plugin log is at `<dataDir>/logs/opencode-memory.log`. OpenCode's own log is under its platform data directory (`~/Library/Logs/opencode` or the equivalent). The plugin never logs tokens, but review logs before sharing them.

## "Setup: not configured"

Cause: no `config.json`, or `setup_completed_at` is missing.

Fix: run setup with a private GitHub repository URL and a stable developer ID.

```text
/memory-setup https://github.com/you/opencode-memory.git alice
```

If setup returns an error, the configuration is not saved. Correct the error and run it again.

## Setup fails with "Authentication or repository access failed"

Check, in order:

1. The repository exists and is **private**.
2. Your account has at least write access.
3. `gh auth status` reports the right account.
4. If using a token, it has Contents read/write for this repository and any SSO authorization is complete.
5. If using SSH, `ssh -T git@github.com` succeeds.
6. The URL is `https://github.com/owner/repo.git` or `git@github.com:owner/repo.git`, without embedded credentials.

The plugin verifies **read** with `ls-remote`/clone and **write** with `push --dry-run`. A repository can be readable but not writable; doctor reports that separately.

## "Do not embed credentials in the repository URL"

Use a credential helper, `gh auth login`, an SSH URL, or `OPENCODE_MEMORY_GITHUB_TOKEN` instead of `https://user:token@github.com/...`.

## Sync fails but OpenCode still works

This is expected. Collection is queue-first:

1. Records are appended to `<dataDir>/queue/*.jsonl` as they are captured.
2. A sync drains the queue into `repo/`, commits, then fetches/rebase/pushes.
3. If the network, GitHub, or Git fails, the queue and local commits remain.
4. The next scheduled or manual sync retries.

Run `/memory-sync` when connectivity returns. Check `pending records` and `unpushed commits/changes` in status.

## Push is rejected repeatedly

The plugin fetches, rebases, and retries up to three times with backoff. It never force-pushes. If rejection persists:

- Another device may still be pushing. Retry shortly.
- Branch protection may block direct pushes. Allow the account to push to the default branch, or use a repository without protection for memory data.
- Credential or policy denials are reported immediately instead of retried.

Local commits are always preserved.

## Conflict reported

Non-JSONL files (for example registry JSON or project Markdown) are not union-merged. On conflict the plugin:

1. Copies conflicted files to `<dataDir>/conflicts/<timestamp>/`.
2. Writes a `README.txt` listing the files.
3. Aborts the rebase so local commits stay intact.
4. Records the conflict in status and logs.

To resolve:

```bash
cd "<dataDir>/repo"
git status
git pull --rebase origin main
# edit conflicted files
git add -A
git rebase --continue
git push origin HEAD:main
```

Then run `/memory-sync`. Review the conflict snapshot before deleting it.

JSONL histories under `histories/**/*.jsonl` use `merge=union` and normally merge without conflicts. Deduplication by `record_id` prevents duplicate records after a union merge.

## Offline recovery

When offline:

- Collection continues into the local queue.
- Sync fails and status shows the error.
- No records are discarded.

When back online, `/memory-sync` drains the queue and pushes. If the remote changed meanwhile, the plugin fetches and rebases first.

## Analysis is not running

Check status for `Last analysis` and `Last analysis error`.

- Analysis is due once per `analysis_interval_hours` (default 24).
- It first requires a successful sync.
- If the checkpoint changed on another device, the stale run is discarded by design; the next run processes the new range.
- `/memory-analyze` forces a run and bypasses the daily interval.

Checkpoints live at `sync/checkpoints/<developer>/<project>.json`.

## Profiles are empty or unchanged

Analysis needs new records. Look for `histories/<project>/<developer>/sessions/*.jsonl`. If files are empty:

- Confirm the plugin is loaded: `opencode plugin list` should show `opencode-memory.context`.
- Confirm the project mapping points at the project you are using.
- Check that collection is not paused.
- Remember that `session.context()` only returns messages after the latest compaction; work from before a compaction may not be recoverable.

## Context is not injected

- `context_max_chars` must be greater than `0`.
- The project must have canonical content or a profile. Fresh repositories contain placeholder Markdown that is intentionally minimal.
- A session from a different OpenCode project will not receive this project's context unless `collect_all_projects` is enabled.
- The injected block is a system message, not a visible chat message. Check `ctx.session.hook("context")` behavior with a debug log if needed.
- Context is cached for 30 seconds per project. A new profile may take a moment to appear.

## "Another OpenCode Memory process is using the repository"

Git work is serialized with an in-process lock and a `state/locks/*.lock` directory lock. The lock expires after 10 minutes and the wait timeout is 30 seconds. If a process crashed, remove the stale lock directory only after confirming no OpenCode process is active:

```bash
rm -rf "<dataDir>/state/locks"
```

## Malformed or corrupt files

- Malformed queue lines are moved to `<dataDir>/queue/corrupt/*.txt`; valid lines continue.
- Malformed history lines are ignored when reading and logged. They are not deleted automatically. Repair them in the private repository or remove the bad lines deliberately.
- A corrupt `config.json` produces a configuration error instead of crashing. Fix it or move it aside and run setup again.
- A corrupt `state/runtime.json` is treated as empty state.

## "data directory exists and is not a Git repository"

Setup never overwrites a non-empty directory. Move the existing directory aside or choose a different `dataDir`/`OPENCODE_MEMORY_DATA_DIR`.

## Commands do not appear

- `opencode plugin list` should show `opencode-memory.context`. If not, check the plugin path and the OpenCode log for load errors.
- A directory plugin needs `index.ts` at its root. This package ships one.
- Commands register when the plugin setup runs at a location; create or open a session in the project directory, then retry.
- In a live-server test, commands appeared in `/api/command` only after a session existed at that location.

## The npm package cannot be loaded

- The package requires `@opencode/plugin@^2.1.2` and a compatible OpenCode V2 runtime.
- Use a version of the plugin tested with your OpenCode version. OpenCode V2 plugin APIs can change between minor releases.
- If loading from a local checkout, use the absolute path to the package or the root `index.ts` entrypoint.

## Reporting a problem

Collect:

- `opencode --version`
- Plugin version (`package.json`)
- `/memory-doctor` output with tokens and repository URLs removed
- Relevant lines from `<dataDir>/logs/opencode-memory.log`
- Whether the repository is GitHub.com, and which auth method is used

Never paste a personal access token, private key, or session transcript containing secrets.
