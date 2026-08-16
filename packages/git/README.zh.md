# git/ - git 能力家族

English | [中文](README.md)

git 能力：一个面向模型的 `git` 工具，通过 `ctx.subprocess` 缝以固定的 argv 模板启动**系统 git 二进制** — 绝不经过 `ctx.shell`，绝不开模型可见的后台任务。它跟踪文件修改（`status`、`diff`、`log`）并执行基础仓库操作（`add`、`commit`、`push`、`pull`、`merge`、`branch`、`checkout`、`restore`、`init`）。**产品**包。

| 包 | 角色 | ctx key |
|---|---|---|
| `tool-git/` | 基于系统 git 二进制的面向模型 `git` 工具；拥有 schema、参数校验、argv 构造、解析、输出上限与截止时间 | （注册到 `ctx.tools`） |

为何选择 spawn 而非能力缝：与 [ripgrep 搜索工具](../fs/README.md) 相同，git 是围绕外部二进制的单一进程工作流。subprocess 缝拥有 spawn 执行、进程树终止、环境清洗与有界输出捕获；本包拥有面向模型的契约。需要限制或门控 git 操作的部署应添加 `tools/pre-execute` 策略监听器 — 工具本身非受限启动且不施加任何审批策略，与产品"策略属于扩展点"的规则一致。

本工具要求 subprocess 提供者的执行世界 PATH 上有系统 `git`（`branch` 列表格式与 `init -b` 需要 git ≥ 2.32）。在同址部署中，git 工作目录与文件系统 `read`/`write` 根是同一工作区，被跟踪文件可被后续读取；该同址要求与搜索工具携带的、已记录的 v1 部署要求相同。
