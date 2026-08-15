# Agent Note: 反向双语配对与中文默认的根 README

Status: implemented

[English](2026-08-16-reversed-bilingual-pairs-and-chinese-default-readme.md) | 中文

## 问题

双语配对约定把不带后缀的 `foo.md` 规定为每对文档的英文侧、`foo.zh.md` 为中文侧，因此根 README 默认展示的文档是英文。产品的主要受众与社区渠道是中文，打包的桌面安装程序（见[桌面外壳注记](../feature/2026-08-15-desktop-electron-shell.md)）也面向中文优先的安装体验；访问仓库或安装程序的读者会先看到英文首页。

## 决策

根 README 配对反向化：`README.md` 是简体中文侧（在 GitHub、npm 与所有其他渲染器上默认展示的文档），英文侧使用 `README.en.md` 后缀；`README.zh.md` 删除。反向配对是一般性的契约功能，通过 [scripts/translation-pairing-record.ts](../../../../scripts/translation-pairing-record.ts) 中的 `REVERSED_PAIR_STEMS` 按 stem 声明；根 README 是第一个反向配对。配对门禁、合并驱动、翻译 brief 生成器、翻译 prompt 与记录工具都按 stem 解析反向配对；其余规则——三文件三元组、一致性记录、语言切换行（中文侧链回英文文件）与结构签名——一律不变。

桌面安装路径写进根 README 新增的「桌面应用 / Desktop app」章节；桌面包自己的 README 与其 Agent Note 补齐缺失的中文版，使语料恢复绿色。根 README 沿用[产品优先注记](2026-07-22-product-first-root-readme.md)确立的结构与语气。

## 考虑过的替代方案

**保留英文默认配对，依靠 README.zh.md。** `.zh.md` 一侧在 GitHub 或 npm 上永远不会默认渲染，默认展示仍然是英文；只有配对自身的切换行可被发现。

**把根 README 从配对中排除。** 契约明确规定不存在 README 专属的策略类别；排除会让最显眼的文档失去配对，削弱双语保证。

**根据磁盘上的文件自动推断方向。** 隐式推断会在出现多余 `foo.en.md` 时悄悄重新解释既有的 `foo.md` + `foo.zh.md` 配对；显式 stem 让方向成为可评审的声明。

## 结果

GitHub、npm 与打包安装程序的落地页面优先展示中文；英文读者通过 `README.en.md` 链接切换。链接到根 README 的文档以中文标题锚点（运行 / 从源码运行）指向 `README.md`，维持「链接指向 `.md` 路径」的约定。今后新增反向配对只需向 `REVERSED_PAIR_STEMS` 加入其 stem；工具无需再改。`README.zh.md` 从此退出历史，指向它的交叉链接须按目标语言改为 `README.en.md` 或 `README.md`。
