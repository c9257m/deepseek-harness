# git/ - git capability family

English | [中文](README.zh.md)

The git capability: one model-facing `git` tool that spawns the **system git binary** through the `ctx.subprocess` seam with fixed argv templates — never `ctx.shell`, never a model-visible background task. It tracks file modifications (`status`, `diff`, `log`) and performs the basic repository operations (`add`, `commit`, `push`, `pull`, `merge`, `branch`, `checkout`, `restore`, `init`). A **product** package.

| Package | Role | ctx key |
|---|---|---|
| `tool-git/` | Model-facing `git` tool over the system git binary; owns schemas, argument validation, argv construction, parsing, output bounds, and the deadline | (registers on `ctx.tools`) |

Why spawn-backed, not a capability seam: like the [ripgrep-backed search tools](../fs/README.md), git is a single-process workflow over an external binary. The subprocess seam owns spawn execution, process-tree termination, environment scrubbing, and bounded output capture; this package owns the model-facing contract. A deployment that wants git operations confined or gated adds a `tools/pre-execute` policy listener — the tool itself spawns unconfined and applies no approval policy, matching the product's "policy belongs on extension points" rule.

The tool requires a system `git` on PATH inside the subprocess provider's execution world (git ≥ 2.32 for the `branch` listing format and `init -b`). In a co-located deployment the git workdir and the filesystem `read`/`write` root are the same workspace, so tracked files are follow-up-readable; that co-location is the same documented v1 deployment requirement the search tools carry.
