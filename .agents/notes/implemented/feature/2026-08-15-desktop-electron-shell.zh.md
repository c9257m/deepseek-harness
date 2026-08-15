# Agent Note: dsh Web UI 的 Electron 桌面外壳

Status: implemented

[English](2026-08-15-desktop-electron-shell.md) | 中文

## 问题

`dsh web` 只能在终端里运行：操作者需要安装 Node、运行 `pnpm dsh web` 或 `npx @deepseek-ai/dsh web`，再在 `http://127.0.0.1:3080` 打开浏览器。仓库里的一键启动 `start-web.bat` 仍然依赖 pnpm/Node 工具链和一次构建。桌面交付物应当能从一个桌面快捷方式启动 harness 并展示其 UI，既不需要安装 Node，也不需要终端命令。

## 决策

`apps/desktop` 交付 `@deepseek-ai/dsh-desktop`，一个 Electron 外壳。它以子进程方式在随包的 Node 运行时上启动 harness Web 服务器，并在原生 BrowserWindow 中展示服务页面，因此打包应用是自包含的：双击快捷方式，harness 即打开。

外壳只负责进程与窗口生命周期：

- **服务器运行时**：打包安装把 Node.js 发行版放在 `resources/runtime` 下（由 `apps/desktop/scripts/fetch-node-runtime.mjs` 拉取，固定为 Node `24.18.1`，落在 harness engine 范围 `^22.19 || >=24` 内）。源码运行时复用开发者自己的 Node。服务器运行在真实 Node 上，绝不运行在 Electron 的内置运行时上，因为 harness loader 通过 `node-addon-require-builtin` 触及 Node 内部；在 `ELECTRON_RUN_AS_NODE` 下该 addon 的 V8-realm 探测会以 `Unsupported/no-realm` 失败，因此 Electron-Node 服务器无法解析其插件包。
- **端口**：外壳以 `--port 32080`（`DSH_DESKTOP_PORT` 可覆盖）启动 `web` profile，与 CLI 默认的 `3080` 不同，然后等待服务器应答再加载 UI。启动失败或提前退出会在窗口内显示错误页，携带子进程 stderr 的尾部。
- **窗口**：splash data URL 覆盖启动过程；`show: false` 加 `ready-to-show` 避免白屏闪烁。同源窗口在应用内打开；其他链接一律经 `shell.openExternal` 离开，`will-navigate` 让外壳始终停留在自己的源上。
- **生命周期**：单实例锁在第二次启动时聚焦既有窗口；关闭窗口即停止服务器（Windows 上用 `taskkill /T`，避免短命工具子进程比父进程活得更久）。
- **打包**：electron-builder NSIS 目标，`asar: false`（应用本来就随包整个 node_modules 闭包），`npmRebuild: false`——在 Windows 上 web profile 挂载的是 PowerShell 栈，绝不用 node-pty，其余原生模块（koffi、`node-addon-require-builtin`）都是 N-API 预编译产物，因此既不需要 Electron-ABI 重编译，也不需要编译器工具链。
- **依赖闭包**：`@deepseek-ai/dsh-desktop` 把 harness 的运行时对等集声明为直接依赖，镜像 `python/sdk-runtime` 部署根。`pnpm deploy` 和 electron-builder 的 node-module 收集器都会剪除对等依赖；harness 以对等方式挂载 Service Definition 包（cordis、`dsh-invariants`、`dsh-agent`、`dsh-llm`、vendored 的 `cordis-plugin-*` 等），因此缺少它们的打包闭包会在第一个对等 import 处以 `ERR_MODULE_NOT_FOUND` 启动失败。
- **负载体积与隐私**：安装包裁剪 sourcemap（`!**/*.map`，harness 闭包中约 50MB），把 Chromium locale 包限制为 `en-US` 与 `zh-CN`（省约 45MB；Web UI 自带本地化），并使用最大 NSIS LZMA 预设。所有用户数据——凭据、设置、会话、存储——都存放在 `$DSH_HOME`（默认 `~/.dsh`），位于安装目录之外，因此构建出的安装包绝不携带打包机器的 profile，可以放心分发。Electron 自己的二进制与随包的 `node.exe` 占据其余体积的大头。

## 考虑过的替代方案

**用 Electron 自带的 Node 启动 CLI（`ELECTRON_RUN_AS_NODE`）。** 实测后否决：`node-addon-require-builtin` 在 Electron 下能加载，但 `requireBuiltin('internal/modules/esm/loader')` 抛出 `Unsupported/no-realm (no compatible GetAlignedPointerFromEmbedderData symbol found)`，因此 `ModuleLoader.fromInternal()` 返回 `undefined`，loader 回退到从自身模块路径直接 `import()`，无法解析 workspace 里的 `@deepseek-ai/dsh-*` 插件（pnpm 布局不会把它们提升到根 `node_modules`）。

**启用 `hoist-workspace-packages` 让直接 import 回退得以解析。** 否决：这是为绕过一个降级运行时而做的仓库级安装布局改动，而且会让 harness 失去其内部模块钩子。

**在 Electron 主进程内进程内启动 harness。** 否决：同一个 V8-realm 阻塞因素依然存在，而且 harness 自身的进程生命周期将与 Electron 共享。

**Node SEA 单文件可执行文件加系统浏览器。** 否决：SEA 无法提供窗口，应用仍要依赖外部浏览器，而且把原生模块打进可执行文件也不受支持。

## 结果

打包安装自包含但体积较大：Electron、Node 运行时与整个 harness 依赖闭包一起交付。Windows 是受支持的打包目标；macOS 或 Linux 需要重新启用 node-pty 的重编译（`npmRebuild: false` 是 Windows web profile 的假设）。桌面端口固定（`32080`，可用 `DSH_DESKTOP_PORT` 覆盖）；端口被占用时启动会以窗口内错误失败。外壳还没有自定义应用图标；`build/icon.ico` 是预期的放置位置。该包与 `apps/cli` 一样是发布成员，并在 workspace-constraints 门禁中加入了 `lib` 发布策略。electron-builder 通过 `@electron/get` 5.x workspace override 固定：其默认 `^3.0.0` 解析（3.0.0）缺少 electron-builder 26.15 读取的 `ElectronDownloadCacheMode` 导出，而 electron 包本身要求 `^5.0.0`。打包流水线已推进到 node-module 收集器；产出安装包需在普通终端运行 `pnpm desktop:dist`。
