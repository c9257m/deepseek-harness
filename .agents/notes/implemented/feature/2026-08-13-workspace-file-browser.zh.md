# Agent Note: 工作区文件浏览器——懒加载树、只读查看器、停靠式聊天

Status: implemented

[English](2026-08-13-workspace-file-browser.md) | 中文

## Problem

Web GUI 能列出工作区目录（目录选择器），但没有查看工作区文件的能力：没有树状界面、没有文件预览，也没有能让聊天与编辑器式面板并存的布局。browse 能力只返回目录，文件树因此没有列表来源；GUI 侧也完全没有读文件 RPC。

## Decision

宿主新增专门的文件系统浏览服务 `ctx.fileBrowser`（`@deepseek-ai/dsh-host-file-browser`），在每次 web 组合上都挂载，与目录*选取*如何提供无关。`DirectoryEntry` 新增必填的 `kind: 'directory' | 'file'`；`list` 在一个有界窗口中按名称排序返回文件与目录（面包屑保持 `'directory'`）。目录选择器在客户端过滤文件行（`visibleEntries` 只保留 `kind === 'directory'`），因此其仅目录的交互不变，而文件树复用同一列举。服务新增 `readFile(path, signal)`，在可配置的字节上限（`maxReadBytes`，默认 1 MiB）内返回完整解码的 UTF-8 文本：未完全限定、缺失或非常规文件的目标失败为 `file-unreadable`；超过上限失败为 `file-too-large`；含 NUL 字节的内容失败为 `file-not-text`（二进制拒绝基于完整的有界结果判定）。读取与调用方信号竞速，并关闭被遗弃的句柄，与 `list` 的中止纪律一致。

文件浏览**刻意不归入**[目录选择 seam](../architecture/2026-07-28-directory-picker-capability-seam.md)：该 seam 的后端选择（`native` 与 `browse`）描述的是选取交互，把浏览 RPC 门禁在 `browse` 后端之后会让原生组合下的文件树失效（回环 Windows 主机会解析为 `native`，于是 `host.listDirectory` 应答 `directory-picker-unavailable`）。`-browse` 后端现在把能力方法委托给 `ctx.fileBrowser`，网关直接从该服务提供 `host.listDirectory` / `host.createDirectory` / `host.readFile`。seam note 的决定——可辨识能力联合、后端因交互形态而异——不变；browse 成员的实现移入始终挂载的服务。

线上新增一个 RPC：`host.readFile`（含 schema、路由、客户端方法以及 `file-unreadable` / `file-too-large` / `file-not-text` 错误码行）。客户端 `IWorkspaces` 新增 `readFile`；runtime 的 `WorkspaceRuntime` 经 `api.host.readFile` 暴露它，失败时抛出携带 RPC 错误的结构化 `FileReadError`。连接 fixture 新增文件树与固定内容，使回放通道可以走通浏览器。

布局新增**文件模式**（根布局 store）：`fileMode` 与 `enterFileMode` / `exitFileMode`。进入时若右侧轨道关闭则以契约默认宽度打开它；退出时关闭它。`AppFrame` 声明第五个子插槽 `workspace.fileViewer`；文件模式下中间列渲染它，聊天停靠进右侧轨道（即工具详情面板平时占用的同一轨道，仍可经既有 details 手柄拖动）。切换会话时的"关闭详情"效应在文件模式下被跳过，停靠聊天得以跨会话存活。文件模式期间工具详情面板隐藏。

侧边栏外壳新增会话/文件浏览视图切换（两个页签，外壳局部状态），并声明新子插槽 `sidebar.files`。新插件包 `@deepseek-ai/dsh-client-ui-workspace-files` 注册共享同一打开页签 store 句柄的条目：`FileTree`（侧边栏）以当前会话的规范化 cwd 为根，目录按需展开——每展开一层产生一次 `listDirectory` 调用并本地缓存，隐藏（点前缀）行被过滤——点击文件把它加入共享 store 并调用 `ctx.layout.openFileMode()`；`FileViewer`（中间列，文件模式）渲染**打开页签列表**——同时打开多个文件、按类型区分的文件徽标（扩展名 → 彩色字形，不再统一使用代码图标）、带可选行号栏的按语言语法高亮、以及右键菜单（页签：关闭／关闭其他／关闭全部；主体：开关行号／高亮）——并把宿主业务码映射为本地化文案。高亮复用 ui-primitives 高亮器（为这一消费者导出 `highlightLines`），其懒加载语法经注入 `hooks` 舱的语法加载可观察源在加载后重渲染查看器。关闭最后一个页签清空 store 并调用 `ctx.layout.closeFileMode()`。两个条目都经 `slots.inject()` 按声明条目的生命周期注册。

**代码字体大小是持久化用户设置**：包 node 半侧注册 `workspace-files` 设置命名空间（schema 默认 12 px，范围 10–24；网关的 web 设置允许列表放行它），浏览器半侧经 `ctx.settingsScope` 绑定并镜像进共享 store（设置行与查看器读 store；设置行经 scope 写回），通用设置页的**文件字体大小**行用有界 ± 步进器调整。设置作用域绑定沿用主题 Appearance 行的先例：一个 store、一次绑定、行的 inject 捕获绑定动作完成设置→store 同步。

查看器对可读文本页签**编辑并自动保存**：编辑开关把高亮主体切换为纯文本 `textarea`；编辑内容经新增的 `host.writeFile` RPC 在 1 秒防抖后自动保存，切换或关闭页签时立即刷新，脏页签带圆点标记，保存失败显示带"重试"的错误条。Host 的 `ctx.fileBrowser` 新增 `writeFile(path, content)`，使用 atomic-write 工具（临时文件 + 重命名——读者要么看到旧内容要么看到完整新内容，失败的写不触碰目标），带 fully-qualified 栅栏与 `file-write-failed` 错误码并上到线上。编辑刻意保持纯文本区域：输入时就地高亮/行号（CodeMirror/Monaco 一级）延后，且无并发编辑保护——原子写防止半写文件，但不保证不丢更新。

## Alternatives considered

**在 `listDirectory` 之外另设 `listFiles` RPC**——否决。两个几乎相同的列表 RPC 会重复有界窗口逻辑与线上表面；一个有诚意的混合列表加上客户端目录过滤，让选择器与树共用同一契约。

**文件浏览放进目录选择能力**——首次实现后否决。初版只在 `browse` 选取后端下提供 `host.listDirectory` / `host.readFile`；在原生组合（回环 Windows／`darwin` 主机）下文件树以 `directory-picker-unavailable` 失败。文件浏览是通用 GUI 关注点，因此放入始终挂载的 `ctx.fileBrowser` 服务，picker seam 只保留选取交互。

**文件查看器作为既有 `details` 列的占用者**——否决。确认的产品方向是 IDE 式布局：查看器属于中间列，聊天停靠右侧。停靠聊天复用 details 轨道，而非新增第四列。

**停靠聊天使用独立宽度偏好**——暂不采纳。复用 details 偏好保留一个拖动手柄与一条让步链；聊天面板受同一 `[300, 520]` 钳制，若用户需要更宽再引入专用聊天宽度。

**打开文件不触碰布局**——否决。文件模式的意义恰在于聊天缩到右侧；两个事实（共享 store 中的打开文件、布局模式）由同一手势同时改变。

## Consequences

工作区文件可在侧边栏以懒加载树查看；点击文件在中间列打开只读文本预览，并把聊天停靠为可拖动的右侧面板；多个文件以页签打开，关闭最后一个后恢复普通布局。按类型的文件徽标区分文件种类，代码按语言高亮并带可选行号，右键菜单可关闭页签并切换显示偏好。超过 1 MiB、二进制与不可读的目标显示本地化错误而非内容。目录选择器的交互不变，文件浏览器在每种组合下都可用——原生与浏览选取后端皆然——因为其数据源是始终挂载的 file-browser 服务。后续文件操作（编辑、刷新、显示隐藏）可扩展该服务。查看器只读，树展开不做监听——外部变更不会被推送（延后工作，记录在包 README）。
