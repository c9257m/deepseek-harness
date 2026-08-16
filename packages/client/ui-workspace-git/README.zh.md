# @deepseek-ai/dsh-client-ui-workspace-git

English | [中文](README.md)

Web GUI 的工作区 git 快捷操作面板插件：浏览器半部把面板注册进工作区文件树声明的 `sidebar.files.git` 子插槽，渲染在侧边栏文件视图的树下方。面板从标准 sessions feed 派生工作区路径，通过注入的 share 调用 workspaces 服务的 git 方法，并显示当前分支及 ahead/behind 事实、可拖动调整高度的变更文件桶列表（已暂存／未暂存／未跟踪／冲突）并带逐文件暂存／取消暂存按钮与桶批量操作、全部暂存提交框、推送／拉取／刷新操作与点击切换的本地分支列表（当前分支带标记）— 全部紧凑到适合侧边栏列宽。位于 git 仓库之外的工作区显示「不是 git 仓库」提示而不是控件。

行为事实：已加载的状态与分支以及交互草稿（提交消息、忙碌标志、上次输出／错误）存放在本包的共享 store（`createGitPanelStore`）中，因此这些事实在重挂载后仍然存在；面板是唯一的读写者。状态与分支列表在会话工作区变化与刷新时加载，带超期计数与实时中止，使更新的根或刷新使过期结算失效。操作是独占的（忙碌标志在操作进行中禁用动作）；成功的操作显示确认（`已提交 <shortHash>` / `推送完成` / `拉取完成` / `已暂存 N 个文件` / `已取消暂存 N 个文件`）随后重载状态，失败则在保留过重载的警示行中显示 wire 错误消息。逐文件与批量暂存／取消暂存（`git.stage`/`git.unstage`）让用户先构建选择性索引；提交使用宿主的全部暂存并提交语义（`git.commit`）处理剩余变更，匹配快捷操作的意图。产品文案为中文；英文词典逐键镜像。

面板是纯浏览器组合：只依赖插槽系统（由 [ui-workspace-files](../ui-workspace-files/README.md) 的 FileTree 条目声明的孔）、标准 sessions/workspaces feed 与 locale 席位。git 操作的宿主侧是 [@deepseek-ai/dsh-host-workspace-git](../../host/workspace-git/README.md)，通过 `git.*` RPC 提供。

## Model Experience

None, as the panel is a GUI control; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **仅紧凑列表** — 变更文件桶每个最多显示 20 条路径并带 `+N` 溢出标记；分页或完整源代码管理视图延后。
- **分支列表即点即切** — 列表在点击时立即 checkout；创建／删除／重命名分支管理留给面向模型的 git 工具。
- **提交为全部暂存** — 面板提交所有工作区变更；选择性暂存需要宿主服务尚未暴露的独立暂存动词。
