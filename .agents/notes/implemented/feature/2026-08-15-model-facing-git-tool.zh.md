# Agent Note: Model-facing git tool

Status: implemented

English | [中文](2026-08-15-model-facing-git-tool.md)

## Problem

在 git 仓库中工作的代理没有第一等的方式来跟踪文件修改或执行其工作流所需的基础仓库操作 — `status`/`diff`/`log` 查看变更、`add`/`commit` 记录工作、`push`/`pull` 同步、`merge`/`branch`/`checkout` 管理历史。bash 工具在 POSIX 上覆盖了这些，但它是带引号与沙箱顾虑的自由形式 shell，在 Windows 上不存在（由 pwsh 代替），且其输出是未解析的文本。文件系统工具刻意不了解 git 状态。模型需要的是一个结构化的 git 表面，并具备基于 ripgrep 的 `glob`/`grep` 发现工具已经确立的 spawn 支持、无 shell 保证。

## Decision

交付 `@deepseek-ai/dsh-tool-git`（`packages/git/tool-git`）：一个面向模型的 `git` 工具，通过 `ctx.subprocess` 缝以固定的 argv 模板启动**系统 git 二进制** — 绝不经过 `ctx.shell`，绝不开模型可见的后台任务 — 并注册进基础 bundle，使每个 profile 都能使用。

- **一个工具，一个 exact-one 联合。** `request` 参数是十二个命令的判别联合：`status`、`diff`、`log`（跟踪）、`add`、`commit`、`push`、`pull`、`merge`、`branch`、`checkout`、`restore`、`init`。单次注册保持 prompt 表面紧凑，且 schema 的 `command` const 使模型的意图可被机器校验。执行是独占的（git 状态变更不得竞争）。
- **解析安全之处用结构化输出，其余用原始文本。** `status`/`log`/`branch` 解析 git 的稳定格式（`--porcelain=v1 -b`、`--format=…` NUL 记录、`branch --format=…`）为规范值；`commit` 通过后续的 `log -1` 返回新提交的 hash/subject；`diff`/`push`/`pull`/`merge`/`checkout`/`restore`/`init` 返回保留的文本。两种 stdout 获取形态支撑这一划分：PARSE 命令要求完整 stdout（有损读取以 `GIT_OUTPUT_OVERFLOW` 失败，而不是发布静默部分的工作树图景），TEXT 命令采用带溢出的尾部，附带截断提示与溢出文件定位。
- **确定、防提示的调用。** 每次调用前置 `-c color.ui=false -c core.quotepath=false --no-pager`，固定 `GIT_TERMINAL_PROMPT=0`（凭据提示快速失败而不是挂起调用），并把每个模型值当作 `--` 之后（路径时）的普通 argv 元素 — 无 shell 层、无引号。`log` 使用 `--topo-order`，使子提交始终先于父提交，不受 commit-graph 状态影响。
- **自有的边界与截止时间。** `timeoutMs`（默认 60 秒，可逐调用覆盖）、`graceMs`、`outputMaxBytes`/`textSpillMaxBytes`/`parseMaxBytes`/`stderrMaxBytes` 与 `maxLogCommits` 都是经校验的 `Config` 字段；截止时间是 `AbortSignal.any([caller, timeout])` 的融合信号，升级为缝的进程树终止。失败携带本包的 `GitError` 及稳定码（`GIT_FAILED`、`GIT_NOT_A_REPOSITORY`、`GIT_ABORTED`、`GIT_LAUNCH_FAILED`、`GIT_OUTPUT_OVERFLOW`）；非零退出包含 git 的 stderr，对 git 在 stdout 报告的失败（如合并冲突清单）回退到 stdout。
- **策略留在扩展点上。** 本工具与 `tool-fs-search` 完全一样，通过 `ctx.subprocess` 非受限启动；部署用 `tools/pre-execute` 监听器门控或沙箱化 git 操作。唯一内置的命令形态选择是 git CLI 位置参数强制的那些（`push`/`pull` 默认远程为 `origin`；无分支时 `setUpstream` 推送 `HEAD`）。

## Alternatives considered

- **git 能力缝（`git` Service Definition + `git-local` 提供者 + `tool-git` 消费者）。** 暂缓：git 是围绕外部二进制的单一进程工作流，而 ripgrep 搜索工具已确立此类工作流应放在单个 spawn 支持的包中，而非扩展提供者契约。只有在出现第二个 git 执行世界（远程/E2B）时，能力缝才值得拆成三个包；这仍是自然的下一步，包 README 记录了当前的单世界姿态。
- **通过 `ctx.shell`/bash 运行 git。** 否决：bash 执行器在 Windows 上不存在，经 shell 的 git 输出需要引号并存在注入风险，且沙箱化执行器会对只读查询本不需要遵循的文件系统策略加以应用。经由 `ctx.subprocess` 的直接 argv spawn 提供 `glob`/`grep` 已依赖的相同保证。
- **每个 git 命令一个工具（`git_status`、`git_commit`、…）。** 否决：十二个 schema 会主导工具目录和模型 prompt，而一个判别工具就能紧凑描述该能力；联合还让单一执行路径拥有共享的边界、截止时间与错误词汇。
- **每个命令都原始透传输出。** 对 `status`/`log`/`branch`/`commit` 否决：模型与 Code Mode 程序需要解析后的事实（分支、ahead/behind、已暂存文件、提交、新提交 hash），而不是需要重新解析的 porcelain 文本；对输出本质上是散文的命令，原始文本仍是诚实的形态。
- **传入 git 身份（`-c user.name/email`）或强制推送。** 否决：身份属于用户的 git 配置；force-push 形式与其他破坏性/广泛命令（stash、rebase、tag、cherry-pick、reset、远程管理）一起留在 v1 之外，并在 README 中记录为延后事项。

## Consequences

- 模型在每个默认 profile 中获得第一等、结构化的 git 表面，代价是一个系统依赖：裸 `git` 可执行文件必须在 subprocess 执行世界的 PATH 上，且 `branch`/`init -b` 需要 git ≥ 2.32（已记录的部署要求）。
- 工具按设计非受限；沙箱化 git 操作是部署策略的责任，与产品"策略在扩展点上"的规则及搜索工具的姿态一致。
- `GIT_TERMINAL_PROMPT=0` 以快速失败换取交互式凭据输入：对未认证远程的 push/pull 报告 git 的错误而不是等待人工 — 这对无人值守代理是正确的默认值，也是已记录的局限。
- git 操作是独占的前台 spawn；模型无法将耗时的 `push`/`pull` 放到后台，60 秒默认（可逐调用覆盖）预算承认了这一点 — 后台 git 运行延后。
- 工具在注册期间为每个请求贡献一个 schema、一段 prompt 指引与每次调用的结果 token；UI 呈现为通用卡片（原始文本），diff-card hunks 延后。
- 基础 bundle 增加 `tool-git` 行与依赖；`gen-tool-catalog`、模块图与配置目录自动随之重新生成。
