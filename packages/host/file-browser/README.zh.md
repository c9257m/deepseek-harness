# @deepseek-ai/dsh-host-file-browser

[English](README.md) | 中文

Web 宿主的 GUI 文件系统浏览服务：`ctx.fileBrowser` 为浏览器侧的文件树与查看器提供原语——单层列举（文件与目录）、子目录创建与基于 Node 标准库（跨 OS 适配本就由它承担）的有界文本读取。它在每个 web 组合上都挂载，与目录*选取*如何提供无关：无论[目录选择 seam](../directory-picker/README.md)解析为原生 OS 选择器还是应用内浏览对话框，文件浏览器都能工作。[浏览后端](../directory-picker-browse/README.md)把它的能力方法委托给该服务，因此一个实现同时服务选择器对话框与文件浏览器。

行为事实：列举在一个有界窗口中按名称排序返回文件与目录——符号链接解析为目标类型、断链／循环链接跳过、宿主判定 `hidden` 标志（POSIX 点前缀约定）留给客户端展示——`crumbs` 为从根到目标的祖先链（根 crumb 以完整路径标注），`list` 不带路径即列举宿主账户的家目录。`createDirectory` 不递归（父目录缺失是真实失败，不是要补造的层级），且即便被直接调用也把名称校验为单个非空白段，与协议 schema 的栅栏一致。每个原语都拒绝非完全限定的显式路径——相对形态，以及 Windows 上 `isAbsolute` 会放行的无盘符有根形态（`\foo`、`/foo`）与不完整的 UNC 前缀（`\\`、`\\server`）——而不是任由 `resolve` 把它重定位到宿主进程 cwd 或当前盘符之下。单次 `list` 至多返回 `maxEntries` 行（配置项，默认 1000——GitHub 网页端对目录列举采用的同一上限），层级以流式方式经过一个有界窗口，无论目录有多少子项内存都保持 O(maxEntries)：被截断的层级保留按名排序的头部、隐藏行计入上限、只探测窗口内候选，并报告 `truncated: true`。`readFile` 在 `maxReadBytes`（配置项，默认 1 MiB）内返回完整 UTF-8 文本文件：更大、缺失或非常规文件的目标失败为 `file-too-large`／`file-unreadable`，含 NUL 字节的内容失败为 `file-not-text`（二进制拒绝基于完整的有界结果判定）。每个原语都透传调用方的 `AbortSignal`，断连或超时会停止扫描或读取而不是让它继续存活，失败抛出 seam 的类型化 `DirectoryPickerError`，网关直接把它映射到线上错误词表。策略依据：[目录选择能力 seam Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.md)。

## 模型体验

无，该服务服务 GUI 宿主的文件浏览；不会向模型请求发送任何内容。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **Windows 隐藏属性未读取**——Node dirent 不暴露 `FILE_ATTRIBUTE_HIDDEN`，因此在引入值得付出的原生探测之前，各平台都以点前缀判定 `hidden`。
- **无盘符根枚举**——Windows 上祖先链止于盘符根；跨盘符等待浏览器 UI 的路径输入交互，而非这里的枚举原语。
- **全文件系统范围**——没有按部署限制浏览根。`workspace.create` 接受任意路径，因此这里的根限制只是 UX 范围而非安全边界。
- **读取仅限整文件**——超过 `maxReadBytes` 的文件失败为 `file-too-large`；部分／截断读取延后到查看器需要时再做。
