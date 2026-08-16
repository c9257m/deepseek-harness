# @deepseek-ai/dsh-tool-git

English | [中文](README.md)

**面向模型的 `git` 工具** — 一个 `git` 条目，其 `request` 是十二个命令的 exact-one 联合 — 通过 `ctx.subprocess` 缝以固定的 argv 模板启动**系统 git 二进制**：绝不经过 `ctx.shell`，绝不开模型可见的后台任务。它跟踪文件修改（`status`、`diff`、`log`）并执行基础仓库操作（`add`、`commit`、`push`、`pull`、`merge`、`branch`、`checkout`、`restore`、`init`）。本包注入 `tools`、`systemPrompt` 和 `subprocess`；它拥有 schema、参数校验、argv 构造、解析、输出上限和每次调用的截止时间，而 subprocess 缝拥有 spawn 执行、进程树终止、环境清洗和有界输出捕获。

每次调用都前置固定调用 `git -c color.ui=false -c core.quotepath=false --no-pager`，使输出为确定的纯文本、非 ASCII 路径保持可读，并固定 `GIT_TERMINAL_PROMPT=0`，使凭据提示永远不会挂起调用 — 需要凭据的操作快速失败并返回 git 的错误，而不是等待人工输入。模型控制的值（路径、消息、ref）都是普通 argv 元素：不存在 shell 层，因此无需引号；路径参数放在 `--` 之后，使以连字符开头的路径永远不会被解析为旗标。

## 部署要求：系统 git、工作目录与文件系统同址

本工具通过 subprocess 缝的执行世界查找启动裸 `git` 可执行文件，因此该世界中 PATH 上必须有系统 git（`branch` 列表格式和 `init -b` 需要 git ≥ 2.32；更旧的 git 会在这两个命令上失败）。默认工作目录是调用代理的会话工作区（`exec.agent.session.header.cwd`），因此在标准部署中 git 仓库与文件系统 `read`/`write`/`edit` 根是同一个工作区，被跟踪的文件可被后续读取 — 这与 ripgrep 搜索工具携带的、已记录的 v1 同址部署要求相同，且没有运行时跨服务校验。

## 配置

所有键都可选；`Config` 提供下列默认值。

| 键 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `60000` | 每次调用的协作截止时间预算（毫秒）；调用可传入更小的 `timeoutMs` 参数。到期后 subprocess 缝的终止升级杀死进程树，调用以 `GIT_ABORTED` 失败。 |
| `graceMs` | `3000` | 交给 subprocess 缝的终止升级宽限期（毫秒），上限为 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)。 |
| `outputMaxBytes` | `65536` | TEXT 命令（`diff`/`push`/`pull`/`merge`/`checkout`/`restore`/`init`）内联保留 stdout 的上限；更大的流会溢出，结果报告溢出文件路径。 |
| `textSpillMaxBytes` | `20000000` | TEXT 命令 stdout 溢出文件的整流上限；不得小于 `outputMaxBytes`。 |
| `parseMaxBytes` | `2000000` | PARSE 命令（`status`/`log`/`branch`）接受的**完整** stdout 上限；更大的流以 `GIT_OUTPUT_OVERFLOW` 失败，而不是发布静默部分的工作树图景。 |
| `stderrMaxBytes` | `65536` | 保留的 stderr 诊断尾部上限。 |
| `maxLogCommits` | `50` | 一次 `log` 请求可要求的提交数上限；更大的 `count` 被拒绝。 |

## 工具

| 工具 | 请求命令 | 行为 |
|---|---|---|
| `git` | `status` | `git status --porcelain=v1 -b` 解析为 `{ branch, upstream, ahead, behind, staged[], unstaged[], untracked[], conflicted[] }`；重命名/复制条目在 `from` 中携带来源，未合并条目只进入 `conflicted`。 |
| `git` | `diff` | `git diff` 变更文本（可选 `staged`、`stat` 摘要或限定 `path`），原始返回并带截断事实和被截断时的溢出文件定位。 |
| `git` | `log` | `git log --format=%H%x00%h%x00%an%x00%aI%x00%s` 解析为提交，可选 `count` 限制（1..`maxLogCommits`）或 `path` 限定。 |
| `git` | `add` | 暂存 `paths`（`"."` 暂存全部）并回显已暂存路径。 |
| `git` | `commit` | `git commit -m <message>`（可选 `amend`），随后 `git log -1` 读取新提交的 `{ hash, shortHash, subject }`。 |
| `git` | `push` | 上传提交，可选指定 `remote`/`branch` 或 `setUpstream`；v1 不提供 force-push 形式。 |
| `git` | `pull` | 下载并整合，可选 `rebase`。 |
| `git` | `merge` | 将 `ref` 合并进当前分支，可选 `noFastForward` 或 `fastForwardOnly`；冲突以 git 的冲突清单失败（git 将其打印到 stdout）。 |
| `git` | `branch` | 列出分支（当前、上游、ahead/behind、`[gone]`）或 `create`（可选 `from`）/`delete`（可选 `deleteForce`）一个分支。 |
| `git` | `checkout` | 切换到 `branch`，或用 `createBranch` 创建并切换。 |
| `git` | `restore` | 丢弃 `paths` 的工作树变更，或用 `staged` 取消暂存。 |
| `git` | `init` | 在工作目录创建仓库，可选指定初始 `branch`。 |

每个命令都是独占的前台 spawn：调用只在 git 退出、被截止时间终止或被中止后返回。git 自身的退出语义决定成败：退出 0 即成功（即使是 `Already up to date.` / `Everything up-to-date`），任何非零退出都是携带 git 消息的错误。

## 错误

失败携带本包自有的 `GitError`（`HarnessError` 子类），在 `isError` 结果上以 `{ name, code }` 呈现：`GIT_FAILED`（git 非零退出，带 git 的 stderr 或 stdout 摘录）、`GIT_NOT_A_REPOSITORY`（工作目录不在仓库内 — 先 `init` 或另选 `workdir`）、`GIT_ABORTED`（截止时间或调用者取消终止了进程树）、`GIT_LAUNCH_FAILED`（无法启动 git 二进制）、`GIT_OUTPUT_OVERFLOW`（PARSE 命令的 stdout 超过 `parseMaxBytes`）。模型参数错误（空消息、空路径、未知命令）仍是普通工具参数错误。

## Model Experience

### System prompt

#### What the model sees

本插件注册范围内的每个请求都包含下面独立注册的 `tool:git` 指引。代理作用域的工具限制可以隐藏 schema，但不会移除这段 prompt。

##### tool:git guidance

```markdown
Track changes with `git status` and `git diff` before mutating commands, and inspect `git status` after a failed push/pull/merge — the working tree may hold a half-applied state. Investigate the error message before retrying.
```

#### Token effect

工具注册期间每个请求有固定的指引成本。

#### KV Cache effect

插件作用域与指引文本不变时前缀稳定。激活、销毁或编辑该段可能使该 prompt 段的复用失效。

### Tool schema

#### What the model sees

生成的 [`git` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-git) 声明十二命令的 `request` 联合及各命令字段；描述点明每个命令与失败码。

#### Token effect

工具可见的每个请求有固定的 schema 成本。

#### KV Cache effect

工具可见性与 schema 不变时前缀稳定。注册生命周期或作用域限制可能从第一个变化的 schema token 起使复用失效。

### Results

#### What the model sees

`status` 返回工作树图景行（`On branch …`、`Staged:`、`Unstaged:`、`Untracked:`、`Conflicts:` 或 `Working tree clean`）；`log` 每个提交返回一行 `shortHash date author — subject`；`branch` 返回带 `*` 标记及上游跟踪的列表；`diff`/`push`/`pull`/`merge`/`checkout`/`restore`/`init` 返回 git 的文本（stdout，stderr 非空时追加）。被截断的 TEXT 结果附加完整输出溢出文件定位；`commit` 结果是 `Committed <shortHash>: <subject>`。

#### Token effect

内联文本受 `outputMaxBytes` 与 `parseMaxBytes` 限制；解析条目受 `maxLogCommits` 限制；调用与保留结果在压缩前一直留在历史中。

#### KV Cache effect

仅追加；新可见内容跟随可复用的请求前缀，不会使既有 KV-cache 条目失效。

### Tool errors

#### What the model sees

失败被规范化为 `Error: <message>`，并携带结构化的 `GIT_FAILED`、`GIT_NOT_A_REPOSITORY`、`GIT_ABORTED`、`GIT_LAUNCH_FAILED` 或 `GIT_OUTPUT_OVERFLOW` 元数据供调用方使用。

#### Token effect

只有失败的调用会增加这些保留 token。

#### KV Cache effect

仅追加；新可见内容跟随可复用的请求前缀，不会使既有 KV-cache 条目失效。

## Known Limitations and Deferred Work

- **仅基础命令** — stash、rebase、tag、cherry-pick、reset、force-push 形式与远程管理（`remote add`/`remove`）不在 v1 范围内；在 POSIX 部署中由 bash 工具覆盖，其余延后。
- **系统 git 是宿主依赖** — 裸 `git` 可执行文件必须在 subprocess 执行世界的 PATH 上，且 `branch` 列表 / `init -b` 命令需要 git ≥ 2.32；更旧的 git 会以解析或用法错误失败。
- **非受限 spawn** — 本工具通过 `ctx.subprocess` 启动且无沙箱限制；部署用 `tools/pre-execute` 策略监听器门控 git 操作，而非工具本身。
- **无 diff-card UI 呈现** — `diff` 以纯文本渲染（截断尾部携带溢出文件定位）；供 UI diff 卡片使用的逐文件 before/after hunks 延后。
- **仅本地分支列表** — `branch` 只列出本地分支；远程跟踪分支（`git branch -a`）与重命名/强制删除边界情况不在 v1 内。
- **巨大工作树大声失败** — `status`/`log`/`branch` 解析超过 `parseMaxBytes` 时以 `GIT_OUTPUT_OVERFLOW` 失败，而不是返回部分图景。
