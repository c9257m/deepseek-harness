# Agent Note: Web git change marks in the file viewer

Status: implemented

English | [中文](2026-08-16-web-git-change-marks.md)

## Problem

git 快捷操作面板（见 [web git quick actions beneath the file tree](2026-08-15-web-git-quick-actions.md)）列出了变更文件，但无法打开其中任何一个：变更行只是死标签，用户得回到树里再找一次文件。而且一旦文件在查看器中打开，下一个问题——「我改了哪些行？」——依旧没有答案：查看器渲染文件内容时没有任何 git 上下文，在 git 工作区中的编辑会话只能靠猜哪些是新的。

## Decision

两个耦合的能力，全部基于既有缝：

- **变更文件行可直接在查看器中打开。** `sidebar.files.git` 插槽的 owner share 从空对象扩展为 `{ openFile, enterFileMode }` —— 即树自身的打开手势，经 `renderSlot` 传入并由面板消费。行的文件名变为按钮：把 git 报告的路径（`git status --porcelain` 打印的是相对路径，也可能是绝对路径）按会话 cwd 解析成绝对路径后，与树行一样打开。这里的一次路径拼接不可避免——git 给出的是相对路径，而解析结果由宿主侧完成。
- **文件查看器中的逐行变更标记。** 新增 `git.diff` RPC（`GitApi.diff`，`{ path, file }` → `{ diff: { kind, hunks } }`）：在工作区中运行 `git diff HEAD --no-ext-diff -- <file>` —— 取 HEAD 作为基准，使已暂存与未暂存的变更合并呈现 —— 并通过工具包的纯 `parseFileDiff` 把单文件 unified diff 解析成 context/added/deleted 记录的 hunk。宿主解析 file 参数（工作区相对或绝对路径，必须落在工作区内），对 git 未跟踪的文件或尚无任何提交的仓库返回 `kind: 'untracked'` 且 hunk 为空，对干净的已跟踪文件返回 `kind: 'tracked'` 且 hunk 为空。查看器从当前会话的 cwd 推导工作区根，每个（根，路径）对只取一次 diff，并把 hunk 映射到当前内容：新侧记录把所在行标记为 added 或 context；删除锚定到其后第一个新侧行，若 hunk 以删除结尾（如 EOF 处的删除）则锚定到 hunk 之前的行。新增行渲染绿色底色与 tooltip；锚定删除的行渲染红色底色与「删除了 N 行」tooltip；未跟踪文件整体渲染绿色。保存成功后使该标签页的 diff 失效，标记按新内容重新获取；diff 失败（非仓库、缺 git）时正文保持无标记，不干扰读取。

## Alternatives considered

- **内联展示删除内容的完整 split/unified diff 视图。** 否决：查看器是文件查看器，带编辑模式、标签栏与按行号对齐的正文；交错展示删除行会破坏行对齐与编辑到内容的映射。选定的标记方案让每个渲染行都是真实的当前行，删除以红色锚定底色表达——这是编辑器 gutter 模式，而非 diff 文档。
- **在浏览器中获取原始 diff 文本并自行解析。** 否决：解析归宿主（工具包的纯解析器），结构化的 hunks wire 值既可测又稳定，而原始文本会把格式解析推进表示层。
- **用 `git diff`（与索引比较）而非 `git diff HEAD`。** 否决：仅已暂存的变更会不显示任何标记；查看器的问题是「相对上次提交改了什么」，`git diff HEAD` 对已暂存与未暂存都成立。
- **客户端自行计算工作区相对路径再发送。** 否决：路径解析归宿主，查看器不应做去根前缀的运算（大小写不敏感的盘符、尾部分隔符）；宿主内部把绝对文件路径转成工作区相对 pathspec。
- **通过状态桶把未跟踪文件标记为「全部新增」。** 否决：查看器不知道文件处于哪个状态桶；`git.diff` 直接报告 `kind: 'untracked'`，同时覆盖尚无提交的仓库。

## Consequences

- git 变更现在从列表到着色源码只需一次点击：打开行、看到新增/删除行、编辑，保存后标记随新内容重新对齐。
- 标记刻意保持最小——行类与 tooltip，无内联删除内容、无基准/对比选择器——契合查看器「呈现当前文件」的姿态；真正的 diff 文档仍留待后续。
- 网关与运行时各增加一个 RPC 与一个 `IWorkspaces` 方法（`gitDiff`），宿主服务增加一个方法（`diff`）与一个解析器导出（`parseFileDiff`），客户端运行时与测试双打同步实现；wire 与契约覆盖落在 apiproxy、宿主服务、运行时与组件测试套件中。
- 未跟踪文件的整片绿色底色对大体积新文件可能视觉上较吵；tooltip 负责解释，且该底色与任意新增行的语义 token 相同。
