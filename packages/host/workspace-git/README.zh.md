# @deepseek-ai/dsh-host-workspace-git

English | [中文](README.md)

Web 宿主的 GUI git 操作服务：`ctx.workspaceGit` 在工作区目录中为浏览器的快捷操作面板运行 git 命令 — 状态、选择性暂存／取消暂存、全部暂存并提交、推送、拉取、分支列表与分支切换 — 通过 `ctx.subprocess` 缝启动**系统 git 二进制**，使用与面向模型的 [git 工具](../../git/tool-git/README.md) 相同的固定调用（`-c color.ui=false -c core.quotepath=false --no-pager`）与凭据提示固定（`GIT_TERMINAL_PROMPT=0`），并复用该包的纯解析器（`parseStatus`/`parseLog`/`parseBranches`）与错误词汇（`GitError`），使 git 输出解析只有一个归属。与[文件浏览器](../file-browser/README.md)一起挂载在每个 web 组合上；API 网关从此服务提供 `git.*` RPC。

行为事实：每个方法接受完全限定的工作区目录（相对 wire 值直接失败，而不是相对宿主 cwd 或在 Windows 上相对当前驱动器解析）、运行一个前台 git 命令，并返回解析后的 wire 值或类型化的 `GitError`（非仓库目录为 `GIT_NOT_A_REPOSITORY`，自有截止时间或调用者信号为 `GIT_ABORTED`，spawn 失败为 `GIT_LAUNCH_FAILED`，stdout 上限超限为 `GIT_OUTPUT_OVERFLOW`，其他非零退出为 `GIT_FAILED` — 网关把这些映射为稳定的 `git-*` wire 码）。`status` 把 `--porcelain=v1 -b` 解析为分支／上游／ahead-behind 以及已暂存／未暂存／未跟踪／冲突桶和 `clean` 标志；`stage` 把给定的工作区相对路径移入索引（`git add -- <paths>`），`unstage` 再移除它们但保留工作树内容（`git restore --staged -- <paths>`）— 这是面板逐文件按钮与桶批量操作驱动的选择性提交对；`commit` 先暂存全部变更（`add -A`）再以给定消息提交 — 这是面板的快速提交语义，不同于面向模型工具的仅暂存提交 — 并返回新提交的标识；`push`/`pull` 使用分支的上游默认值并返回保留的输出；`branches` 列出带跟踪事实的本地分支；`checkout` 切换到已有的本地分支。解析命令要求**完整** stdout（有损读取以 `GIT_OUTPUT_OVERFLOW` 失败，而不是返回静默部分的工作树图景）；每个操作把调用者信号与自有截止时间（`timeoutMs`，默认 60 秒）融合，使停滞的网络操作无法钉住调用者。本服务是非受限 spawn — git 操作的部署策略属于工具／权限缝，与 git 工具的姿态一致。宿主要求 PATH 上有 git（`unstage` 需要 ≥ 2.23 的 `git restore --staged`，`branches` 列表需要 ≥ 2.32）。

## 配置

所有键都可选；`Config` 提供下列默认值。

| 键 | 默认值 | 含义 |
|---|---|---|
| `outputMaxBytes` | `262144` | 单个命令解析的**完整** stdout 上限；更大的流以 `GIT_OUTPUT_OVERFLOW` 失败。 |
| `timeoutMs` | `60000` | 每次操作的协作截止时间（毫秒）；到期升级为缝的进程树终止（`GIT_ABORTED`）。 |
| `graceMs` | `3000` | 交给 subprocess 缝的终止升级宽限期（毫秒），上限为 `MAX_TIMER_DELAY_MS`。 |

## Model Experience

None, as the service serves the GUI host's git quick actions; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **系统 git 是宿主依赖** — 裸 `git` 可执行文件必须在 subprocess 执行世界的 PATH 上；`unstage` 需要 git ≥ 2.23（`git restore --staged`），`branches` 列表需要 git ≥ 2.32；更旧的 git 会以解析错误失败。
- **非受限 spawn** — 本服务通过 `ctx.subprocess` 运行 git 且无沙箱限制；部署用自己的策略缝门控 git 操作，而非本服务。
- **仅基础命令** — stash、rebase、tag、reset、force-push 形式与远程管理不在面板的快捷操作集内；更广泛的操作由面向模型的 git 工具覆盖。
- **快速提交暂存全部** — `commit` 在提交前运行 `add -A`；面板的 `stage`/`unstage` 为随后的提交提供选择性暂存，但按 hunk 暂存的面板仍延后。
