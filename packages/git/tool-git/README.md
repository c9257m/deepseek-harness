# @deepseek-ai/dsh-tool-git

English | [中文](README.zh.md)

The **model-facing `git` tool** — one `git` entry whose `request` is an exact-one union of twelve commands — spawns the **system git binary** through the `ctx.subprocess` seam with fixed argv templates: never `ctx.shell`, never a model-visible background task. It tracks file modifications (`status`, `diff`, `log`) and performs the basic repository operations (`add`, `commit`, `push`, `pull`, `merge`, `branch`, `checkout`, `restore`, `init`). The package injects `tools`, `systemPrompt`, and `subprocess`; it owns schemas, argument validation, argv construction, parsing, output bounds, and the per-call deadline, while the subprocess seam owns spawn execution, process-tree termination, environment scrubbing, and bounded output capture.

Every call prepends the fixed invocation `git -c color.ui=false -c core.quotepath=false --no-pager` so output is deterministic plain text and non-ASCII paths stay readable, and pins `GIT_TERMINAL_PROMPT=0` so a credential prompt can never hang a call — an operation that needs credentials fails fast with git's error instead of waiting for a human. Model-controlled values (paths, messages, refs) are plain argv elements: no shell layer exists, so no quoting applies, and path arguments ride behind `--` so a leading-dash path can never parse as a flag.

## Deployment requirement: system git, co-located workdir/filesystem

The tool spawns the bare `git` executable through the subprocess seam's execution-world lookup, so a system git must be on PATH in that world (git ≥ 2.32 for the `branch` listing format and `init -b`; older git fails those two commands). The default workdir is the calling agent's session workspace (`exec.agent.session.header.cwd`), so in the standard deployment the git repository and the filesystem `read`/`write`/`edit` root are the same workspace and tracked files are follow-up-readable — the same documented v1 co-location requirement the ripgrep-backed search tools carry, with no runtime cross-service validation.

## Config

All keys are optional; `Config` supplies the defaults below.

| Key | Default | Meaning |
|---|---|---|
| `timeoutMs` | `60000` | Cooperative per-call deadline budget in milliseconds; a call may pass a smaller `timeoutMs` argument. When it expires, the subprocess seam's terminate escalation kills the process tree and the call fails `GIT_ABORTED`. |
| `graceMs` | `3000` | Terminate-escalation grace (ms) handed to the subprocess seam, bounded by [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md). |
| `outputMaxBytes` | `65536` | Cap on stdout a TEXT command (`diff`/`push`/`pull`/`merge`/`checkout`/`restore`/`init`) retains inline; a larger stream spills and the result reports the spill path. |
| `textSpillMaxBytes` | `20000000` | Whole-stream cap for a TEXT command's stdout spill file; must be no smaller than `outputMaxBytes`. |
| `parseMaxBytes` | `2000000` | Cap on the COMPLETE stdout a PARSE command (`status`/`log`/`branch`) accepts; a larger stream fails with `GIT_OUTPUT_OVERFLOW` rather than publish a silently-partial working-tree picture. |
| `stderrMaxBytes` | `65536` | Cap on the retained stderr diagnostic tail. |
| `maxLogCommits` | `50` | Cap on commits one `log` request may ask for; a larger `count` is rejected. |

## Tools

| Tool | Request commands | Behavior |
|---|---|---|
| `git` | `status` | `git status --porcelain=v1 -b` parsed into `{ branch, upstream, ahead, behind, staged[], unstaged[], untracked[], conflicted[] }`; rename/copy entries carry their source in `from`, and unmerged entries land only in `conflicted`. |
| `git` | `diff` | `git diff` change text (optionally `staged`, a `stat` summary, or scoped to `path`), returned raw with truncation facts and the spill locator when capped. |
| `git` | `log` | `git log --format=%H%x00%h%x00%an%x00%aI%x00%s` parsed into commits, optionally `count`-limited (1..`maxLogCommits`) or `path`-scoped. |
| `git` | `add` | Stage `paths` (`"."` stages everything) and echo the staged paths. |
| `git` | `commit` | `git commit -m <message>` (optionally `amend`), then a follow-up `git log -1` reads the new commit's `{ hash, shortHash, subject }`. |
| `git` | `push` | Upload commits, optionally to a `remote`/`branch` or with `setUpstream`; no force-push forms in v1. |
| `git` | `pull` | Download and integrate, optionally `rebase`. |
| `git` | `merge` | Merge `ref` into the current branch, optionally `noFastForward` or `fastForwardOnly`; a conflict fails with git's listing (which git prints on stdout). |
| `git` | `branch` | List branches (current, upstream, ahead/behind, `[gone]`) or `create` (optionally `from`)/`delete` (optionally `deleteForce`) one. |
| `git` | `checkout` | Switch to `branch` or create-and-switch with `createBranch`. |
| `git` | `restore` | Discard working-tree changes for `paths`, or unstage with `staged`. |
| `git` | `init` | Create a repository in the workdir, optionally with an initial `branch`. |

Every command is an exclusive, foreground spawn: the call returns only after git exits, is terminated by the deadline, or is aborted. Git's own exit semantics decide success: exit 0 is success (even `Already up to date.` / `Everything up-to-date`), any non-zero exit is an error carrying git's message.

## Errors

Failures carry the package-owned `GitError` (a `HarnessError` subclass), surfaced as `{ name, code }` on `isError` results: `GIT_FAILED` (a non-zero git exit, with git's stderr or stdout excerpt), `GIT_NOT_A_REPOSITORY` (the workdir is not inside a repository — `init` first or pick another `workdir`), `GIT_ABORTED` (the deadline or caller cancellation terminated the process tree), `GIT_LAUNCH_FAILED` (the git binary could not be started), and `GIT_OUTPUT_OVERFLOW` (a PARSE command's stdout exceeded `parseMaxBytes`). Model argument mistakes (blank message, empty paths, an unknown command) stay ordinary tool argument errors.

## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope contains the independently registered `tool:git` guidance below. Agent-scoped tool restrictions can hide the schema without removing this prompt section.

##### tool:git guidance

```markdown
Track changes with `git status` and `git diff` before mutating commands, and inspect `git status` after a failed push/pull/merge — the working tree may hold a half-applied state. Investigate the error message before retrying.
```

#### Token effect

Fixed guidance cost per request while the tool is registered.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Activation, disposal, or editing the section may invalidate reuse from this prompt section.

### Tool schema

#### What the model sees

The generated [`git` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-git) declares the twelve-command `request` union with per-command fields; the description names every command and the failure codes.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while tool visibility and the schema are unchanged. Registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Results

#### What the model sees

`status` returns the working-tree picture lines (`On branch …`, `Staged:`, `Unstaged:`, `Untracked:`, `Conflicts:`, or `Working tree clean`); `log` returns one `shortHash date author — subject` line per commit; `branch` returns a `*`-marked listing with upstream tracking; `diff`/`push`/`pull`/`merge`/`checkout`/`restore`/`init` return git's text (stdout, plus stderr when non-empty). A truncated TEXT result appends the complete-output spill locator; a `commit` result is `Committed <shortHash>: <subject>`.

#### Token effect

Inline text is bounded by `outputMaxBytes` and `parseMaxBytes`; parsed items by `maxLogCommits`; the call and retained result remain in history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Failures are normalized as `Error: <message>` with structured `GIT_FAILED`, `GIT_NOT_A_REPOSITORY`, `GIT_ABORTED`, `GIT_LAUNCH_FAILED`, or `GIT_OUTPUT_OVERFLOW` metadata for callers.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Basic commands only** — stash, rebase, tag, cherry-pick, reset, force-push forms, and remote management (`remote add`/`remove`) are outside v1; on POSIX deployments the bash tool covers them, and the rest is deferred.
- **System git is a host dependency** — the bare `git` executable must be on PATH in the subprocess execution world, and the `branch` listing / `init -b` commands need git ≥ 2.32; older git fails them with a parse or usage error.
- **Unconfined spawn** — the tool spawns through `ctx.subprocess` without sandbox confinement; deployments gate git operations with a `tools/pre-execute` policy listener, not with the tool itself.
- **No diff-card UI presentation** — `diff` renders as plain text (truncated tails carry the spill locator); per-file before/after hunks for a UI diff card are deferred.
- **Local branch listing only** — `branch` lists local branches; remote-tracking branches (`git branch -a`) and rename/force-delete edge cases stay out of v1.
- **Huge working trees fail loud** — a `status`/`log`/`branch` parse exceeding `parseMaxBytes` fails with `GIT_OUTPUT_OVERFLOW` instead of returning a partial picture.
