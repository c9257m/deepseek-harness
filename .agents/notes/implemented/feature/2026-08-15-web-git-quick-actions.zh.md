# Agent Note: Web git quick actions beneath the file tree

Status: implemented

English | [中文](2026-08-15-web-git-quick-actions.md)

## Problem

Web GUI 的文件浏览器让用户查看和编辑工作区文件，但没有 git 表面：代理产生的变更可以在侧边栏树中检查、在中间查看器中编辑，但提交、推送、拉取或切换分支需要回到终端或让模型通过 bash 工具运行 git。面向模型的 `git` 工具覆盖了代理驱动的操作，但文件浏览会话的人工侧没有任何快捷操作，GUI 也无法回答任何编辑会话的第一个问题——「这个工作区改了什么？在哪个分支上？」。

## Decision

在侧边栏文件树下方新增 git 快捷操作面板及其支撑的 wire，全部基于既有缝：

- **`@deepseek-ai/dsh-host-workspace-git`（`ctx.workspaceGit`）** — web 宿主服务，通过 `ctx.subprocess` 在工作区目录运行 git，复用面向模型工具包的纯解析器（`parseStatus`/`parseLog`/`parseBranches`）、错误词汇（`GitError`）、固定调用与 `GIT_TERMINAL_PROMPT=0` 固定，使 git 输出解析只有一个归属。方法：`status`、`commit`（先全部暂存再提交 — 面板的快速提交语义，不同于工具的仅暂存提交）、`push`、`pull`、`branches`、`checkout`。每个操作融合调用者信号与自有截止时间，解析命令要求完整 stdout（有损读取即 `GIT_OUTPUT_OVERFLOW`），并拒绝相对 wire 路径。
- **网关中的 `git.*` RPC 域** — `GitApi` 契约、zod schema、fetch 路由、客户端 face，以及 ApiProxy 中由 `ctx.workspaceGit` 提供的 `git` aggregate，并在 `RpcErrorDetailsMap` 中新增稳定 wire 码（`git-not-a-repository`、`git-failed`、`git-aborted`、`git-launch-failed`、`git-output-overflow`）。
- **客户端接线** — 运行时 `IWorkspaces` face 新增 `gitStatus`/`gitCommit`/`gitPush`/`gitPull`/`gitBranches`/`gitCheckout`（抛出类型化的 `GitOperationError`），fixture 与测试双打实现新方法。
- **`@deepseek-ai/dsh-client-ui-workspace-git`** — 面板填充由 ui-workspace-files 的 FileTree 条目声明并渲染在树下方的 `sidebar.files.git` 子插槽。它显示分支及 ahead/behind 事实、变更文件桶（已暂存／未暂存／未跟踪／冲突）、全部暂存提交框、推送／拉取／刷新操作与分支切换器，非仓库显示「不是 git 仓库」提示。面板状态存放在共享 store；操作独占（忙碌标志），失败的错误行在操作后的状态重载中保留。
- **组合** — web-app bundle 挂载宿主服务与客户端插件；fixture 数据源为无密钥 e2e 车道提供确定性的 git 状态。

## Alternatives considered

- **直接复用面向模型的 `git` 工具的 `runGit`。** 否决：`runGit` 接受 `ToolExecution`（工具消费者的身份），且工具包是面向模型的消费者；宿主服务只导入纯解析器与错误词汇，自行拥有基于 `ctx.subprocess` 的薄 spawn 封装。
- **扩展 `ctx.fileBrowser` 加入 git 方法。** 否决：文件浏览与版本控制是不同领域；网关已把它们当作独立 RPC 表面，混在一起会让文件系统浏览服务的契约长出属于 git 缝的操作。
- **为 git 单独开一个侧边栏视图标签。** 否决：「文件下面」是要求的放置位置，独立标签会把编辑会话的两个问题（改了什么＋树）拆到不同视图；树下方子插槽让它们保持在一起。
- **在宿主包中复制 porcelain/format 解析器。** 否决，改为导入工具包导出的纯函数 — 依据 dependencies-over-hand-rolling 规则，git 输出解析只有一个归属。

## Consequences

- 编辑会话的人工侧无需离开文件视图即可完成状态查看、提交、推送、拉取与分支切换；代理侧保留面向模型的工具。两者共享同一解析词汇与同一错误码族。
- 提交动词按设计为全部暂存：面板表达的是「提交我的工作区变更」，而非选择性暂存 — 在出现独立暂存动词前是已记录的局限。
- 面板通过 `ctx.subprocess` 非受限执行 git，与文件浏览器和 git 工具的姿态一致；git 操作的部署策略留在权限缝。
- web bundle 增加两个包与六个 RPC 方法；模块图、配置目录、客户端插槽目录与翻译对随之重新生成。由于面板直接组合在文件树上，同一变更也修复了既有的 file-browser/workspace-files 注册漂移（缺失的 tsconfig 路径映射与 aggregate 引用）。
