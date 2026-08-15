# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

dsh Web UI 的 Electron 桌面外壳。它以子进程方式在 Node 上启动 harness Web 服务器，并在原生窗口中展示服务页面，因此打包安装既不需要单独安装 Node.js，也不需要终端命令：双击桌面快捷方式即可打开 harness。

外壳只负责进程与窗口生命周期——启动与停止服务器、单实例锁与同源窗口处理。模型密钥、工作区与插件都在 Web UI 本身中配置。

## 运行时模型

服务器运行在真实 Node 上，绝不运行在 Electron 的内置运行时上：harness loader 通过 `node-addon-require-builtin` 触及 Node 内部，而它在 Electron 的 V8 realm 中会失败（`ELECTRON_RUN_AS_NODE` 报告 `Unsupported/no-realm`），因此 Electron-Node 服务器无法解析其插件包。打包安装会把 Node 发行版随包放在 `resources/runtime` 下；源码运行时则复用开发者自己的 Node。

## 从源码运行

需要先完成完整的 harness 构建（`pnpm run build`），它会产出 `apps/cli/lib/bin.js` 的 CLI bundle 与前端产物。

```sh
pnpm run build
pnpm desktop:dev
```

外壳在端口 `32080`（可用 `DSH_DESKTOP_PORT` 覆盖）上启动 `web` profile，与 CLI 默认的 `3080` 不同。关闭窗口即停止服务器。

## 构建安装包

```sh
pnpm desktop:pack        # unpacked app directory, for faster iteration
pnpm desktop:dist        # NSIS installer under apps/desktop/dist
```

两者都会在运行 electron-builder 之前先拉取固定的 Node 运行时（`apps/desktop/scripts/fetch-node-runtime.mjs` 将其下载到 `apps/desktop/runtime/`）。Windows 是受支持的打包目标；Electron 版本被固定，使其内置 Node 满足 harness 的 engine 范围（`^22.19 || >=24`），拉取的 Node 发行版行与之一致。

`@deepseek-ai/dsh-desktop` 把 harness 的运行时对等集声明为直接依赖（镜像 `python/sdk-runtime` 部署根）：打包收集器会剪除对等依赖，而 harness 以对等方式挂载其 Service Definition 包，因此打包闭包必须显式携带它们，否则启动会以 `ERR_MODULE_NOT_FOUND` 失败。

## 隐私与体积

所有用户数据——模型凭据、设置、会话与存储——都存放在 `$DSH_HOME`（默认 `~/.dsh`），位于安装目录之外。安装包只捆绑应用负载（Electron、Node 运行时与 harness 闭包）；它绝不包含打包机器的凭据，因此同一安装包可以放心交给其他人。每次安装都以全新、空的 profile 开始。

负载做了体积裁剪：排除 sourcemap（`!**/*.map`，约 50MB）；Chromium 只带 `en-US` 与 `zh-CN` 两个 locale 包（省约 45MB）；NSIS 安装包使用最大 LZMA 预设。Electron 自身与随包的 `node.exe` 占据其余体积的大头，且无法再削减。

## 已知限制与延后工作

- **不做按主机的原生重编译**（`npmRebuild: false`）。在 Windows 上 web profile 挂载的是 PowerShell 栈，绝不用 node-pty，其余原生模块（koffi、`node-addon-require-builtin`）都是 N-API 预编译产物，因此打包应用按安装时的依赖原样发布。macOS 或 Linux 打包需要重新启用 node-pty 的重编译。
- **还没有自定义应用图标**；打包应用使用 Electron 默认图标。`build/icon.ico` 是预期的放置位置。
- **桌面端口固定**：桌面端口被占用时启动会在窗口内报错失败；释放端口后重新启动，或在启动前设置 `DSH_DESKTOP_PORT`。
