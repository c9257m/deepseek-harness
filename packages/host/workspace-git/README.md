# @deepseek-ai/dsh-host-workspace-git

English | [中文](README.zh.md)

GUI git-operations service for the web host: `ctx.workspaceGit` runs git commands in a workspace directory for the browser's quick-action panel — status, selective stage/unstage, stage-all-and-commit, push, pull, branch listing, and branch checkout — spawning the SYSTEM git binary through the `ctx.subprocess` seam with the same fixed invocation (`-c color.ui=false -c core.quotepath=false --no-pager`) and credential-prompt pin (`GIT_TERMINAL_PROMPT=0`) the model-facing [git tool](../../git/tool-git/README.md) uses, and reusing that package's pure parsers (`parseStatus`/`parseLog`/`parseBranches`) and error vocabulary (`GitError`) so one home owns git output parsing. Mounted on every web composition beside the [file browser](../file-browser/README.md); the API gateway serves the `git.*` RPCs from this service.

Behavior facts: every method takes a fully-qualified workspace directory (relative wire values fail instead of resolving against the host cwd or, on Windows, its current drive), runs one foreground git command, and returns the parsed wire value or a typed `GitError` (`GIT_NOT_A_REPOSITORY` for a non-repo directory, `GIT_ABORTED` for the owned deadline or the caller signal, `GIT_LAUNCH_FAILED` for a failed spawn, `GIT_OUTPUT_OVERFLOW` for a stdout cap breach, `GIT_FAILED` for any other non-zero exit — the gateway maps these onto the stable `git-*` wire codes). `status` parses `--porcelain=v1 -b` into branch/upstream/ahead-behind plus the staged/unstaged/untracked/conflicted buckets and a `clean` flag; `stage` moves the given workspace-relative paths into the index (`git add -- <paths>`) and `unstage` removes them again keeping working-tree content (`git restore --staged -- <paths>`) — the selective-commit pair the panel's per-file buttons and bucket batch actions drive; `commit` stages every change (`add -A`) then commits with the given message — the panel's quick-commit semantics, unlike the model-facing tool's staged-only commit — and returns the new commit's identity; `push`/`pull` use the branch's upstream defaults and return the retained output; `branches` lists local branches with tracking facts; `checkout` switches to an existing local branch. Parsed commands require COMPLETE stdout (a lossy read fails `GIT_OUTPUT_OVERFLOW` rather than return a silently-partial working-tree picture), and each operation fuses the caller's signal with an owned deadline (`timeoutMs`, default 60 s) so a stalled network operation cannot pin a caller. The service is an unconfined spawn — deployment policy for git operations belongs to the tool/permission seams, mirroring the git tool's posture. The host requires git on PATH (≥ 2.23 for `git restore --staged`, ≥ 2.32 for the branch listing format).

## Config

All keys are optional; `Config` supplies the defaults below.

| Key | Default | Meaning |
|---|---|---|
| `outputMaxBytes` | `262144` | Cap on the COMPLETE stdout one command parses; a larger stream fails `GIT_OUTPUT_OVERFLOW`. |
| `timeoutMs` | `60000` | Cooperative per-operation deadline (ms); expiry escalates to the seam's process-tree termination (`GIT_ABORTED`). |
| `graceMs` | `3000` | Terminate-escalation grace (ms) handed to the subprocess seam, bounded by `MAX_TIMER_DELAY_MS`. |

## Model Experience

None, as the service serves the GUI host's git quick actions; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **System git is a host dependency** — the bare `git` executable must be on PATH in the subprocess execution world; `unstage` needs git ≥ 2.23 (`git restore --staged`) and the `branches` listing needs git ≥ 2.32; older git fails those with a parse error.
- **Unconfined spawn** — the service runs git through `ctx.subprocess` without sandbox confinement; deployments gate git operations with their own policy seams, not with this service.
- **Basic commands only** — stash, rebase, tag, reset, force-push forms, and remote management are outside the panel's quick-action set; the model-facing git tool covers broader operations.
- **Quick-commit stages everything** — `commit` runs `add -A` before committing; the panel's `stage`/`unstage` cover selective staging for the commit that follows, but a panel needing per-hunk staging is deferred.
