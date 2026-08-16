# Agent Note: Model-facing git tool

Status: implemented

English | [中文](2026-08-15-model-facing-git-tool.zh.md)

## Problem

An agent working in a git repository had no first-class way to track file modifications or perform the basic repository operations its workflow needs — `status`/`diff`/`log` to see what changed, `add`/`commit` to record work, `push`/`pull` to sync, `merge`/`branch`/`checkout` to manage history. The bash tool covers this on POSIX, but it is a free-form shell with quoting and sandbox concerns, it does not exist on Windows (pwsh does), and its output is unparsed text. The filesystem tools deliberately know nothing about git state. What the model needed was one structured git surface with the same spawn-backed, no-shell guarantees the ripgrep-based `glob`/`grep` discovery tools already established.

## Decision

Ship `@deepseek-ai/dsh-tool-git` (`packages/git/tool-git`), a single model-facing `git` tool that spawns the **system git binary** through the `ctx.subprocess` seam with fixed argv templates — never `ctx.shell`, never a model-visible background task — and register it in the base bundle so every profile gets it.

- **One tool, one exact-one union.** The `request` parameter is a discriminated union of twelve commands: `status`, `diff`, `log` (tracking), `add`, `commit`, `push`, `pull`, `merge`, `branch`, `checkout`, `restore`, `init`. One registration keeps the prompt surface compact and the schema's `command` consts make the model's intent machine-validated. Execution is exclusive (git state mutations must not race).
- **Structured outputs where parsing is safe, raw text elsewhere.** `status`/`log`/`branch` parse git's stable formats (`--porcelain=v1 -b`, `--format=…` NUL records, `branch --format=…`) into canonical values; `commit` returns the new commit's hash/subject via a follow-up `log -1`; `diff`/`push`/`pull`/`merge`/`checkout`/`restore`/`init` return the retained text. Two stdout acquisition shapes back this split: PARSE commands require complete stdout (a lossy read fails `GIT_OUTPUT_OVERFLOW` rather than publish a silently-partial working-tree picture), TEXT commands take a spill-backed tail with a truncation notice and the spill locator.
- **Deterministic, prompt-proof invocation.** Every call prepends `-c color.ui=false -c core.quotepath=false --no-pager`, pins `GIT_TERMINAL_PROMPT=0` (a credential prompt fails fast instead of hanging a call), and treats every model value as a plain argv element behind `--` where it is a path — no shell layer, no quoting. `log` uses `--topo-order` so children stay before parents regardless of commit-graph state.
- **Owned bounds and deadline.** `timeoutMs` (default 60 s, per-call override), `graceMs`, `outputMaxBytes`/`textSpillMaxBytes`/`parseMaxBytes`/`stderrMaxBytes`, and `maxLogCommits` are validated `Config` fields; the deadline is a fused `AbortSignal.any([caller, timeout])` that escalates to the seam's process-tree termination. Failures carry the package `GitError` with stable codes (`GIT_FAILED`, `GIT_NOT_A_REPOSITORY`, `GIT_ABORTED`, `GIT_LAUNCH_FAILED`, `GIT_OUTPUT_OVERFLOW`); a non-zero exit includes git's stderr, falling back to stdout for failures git reports there (merge-conflict listings).
- **Policy stays on the extension points.** The tool spawns unconfined through `ctx.subprocess`, exactly like `tool-fs-search`; deployments gate or sandbox git operations with `tools/pre-execute` listeners. The only command-shape choices baked in are the ones git's CLI positionals force (`push`/`pull` default the remote to `origin`; `setUpstream` without a branch pushes `HEAD`).

## Alternatives considered

- **A git capability seam (`git` Service Definition + `git-local` provider + `tool-git` consumer).** Rejected for now: git is one process-backed workflow over an external binary, and the ripgrep search tools already set the precedent that such workflows live in a single spawn-backed package rather than extending a provider contract. A seam earns its three packages only when a second git execution world (remote/E2B) exists; that remains the natural next step and the package's README documents the current single-world posture.
- **Running git through `ctx.shell`/bash.** Rejected: the bash executor does not exist on Windows, git output through a shell would need quoting and risk injection, and the sandboxed executors would apply filesystem policy the git command does not need to obey for read-only queries. Direct argv spawns through `ctx.subprocess` give the same guarantees `glob`/`grep` already rely on.
- **One tool per git command (`git_status`, `git_commit`, …).** Rejected: twelve schemas would dominate the tool catalog and the model's prompt for a capability one discriminated tool describes compactly; the union also lets a single execution path own the shared bounds, deadline, and error vocabulary.
- **Raw pass-through output for every command.** Rejected for `status`/`log`/`branch`/`commit`: the model and Code Mode programs need the parsed facts (branch, ahead/behind, staged files, commits, new-commit hash), not porcelain text to re-parse; raw text remains the honest shape for commands whose output is inherently prose.
- **Passing git identity (`-c user.name/email`) or forcing push.** Rejected: identity is the user's git config, and force-push forms stay out of v1 with the other destructive/broad commands (stash, rebase, tag, cherry-pick, reset, remote management) recorded as deferred in the README.

## Consequences

- The model gets a first-class, structured git surface in every default profile, at the cost of a system dependency: the bare `git` executable must be on PATH in the subprocess execution world, and `branch`/`init -b` need git ≥ 2.32 (documented deployment requirement).
- The tool is unconfined by design; sandboxing git operations is a deployment-policy responsibility, consistent with the product's "policy on extension points" rule and with the search tools' posture.
- `GIT_TERMINAL_PROMPT=0` trades interactive credential entry for fast failure: a push/pull to an unauthenticated remote reports git's error instead of waiting on a human — the right default for an unattended agent, and a documented limitation.
- Git operations are exclusive foreground spawns; the model cannot background a long `push`/`pull`, which the 60 s default (per-call overridable) budget acknowledges — background git runs are deferred.
- The tool contributes one schema, one prompt guidance section, and per-call result tokens to every request while registered; UI presentation is a generic card (raw text), with diff-card hunks deferred.
- The base bundle gains a `tool-git` row and dependency; `gen-tool-catalog`, the module graph, and the config catalog regenerate from it automatically.
