# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

DeepSeek Harness 桌面壳：一个 Electron 应用（macOS），把现有的浏览器 GUI 装进一个原生窗口。它不重写 GUI——它拉起与终端用户完全相同的 `dsh web` 宿主，等待宿主的就绪行，然后把服务出的界面加载进一个 Electron `BrowserWindow`。关闭窗口即停止宿主并退出。

## 工作原理

主进程（[`src/main.ts`](src/main.ts)）把宿主作为子进程运行并负责窗口生命周期；[`src/server.ts`](src/server.ts) 持有纯启动逻辑（命令解析、就绪行解析、优雅停止），不引入 `electron` 依赖，因此可在纯 Node 下测试。

- `resolveServerCommand` 在仓库根目录运行 `<node> apps/cli/lib/bin.js web --port <port>`——正是 `dsh web` 的调用方式，因此 profile、node_modules 与已构建前端 dist 的解析方式完全相同。
- `spawnServer` 观察子进程 stdout 中的 `dsh web: http://…` 就绪行（与 supervisor 使用的信号一致），并以规范 URL 兑现；窗口只在服务器绑定且路由挂载完成后才加载。
- 该壳默认向 OS 申请一个空闲端口，因此不会与已在运行的 `dsh web` 冲突（`DSH_WEB_PORT` 可固定端口）；宿主运行在 `DSH_NODE_BIN` 解析出的 node 二进制下（默认取 `PATH` 中的 `node`）。

## 运行

```sh
# Build the host + frontend artifacts once, then launch the desktop shell.
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop dev
```

`dev` 编译主进程（`tsc`）并启动 Electron。窗口显示服务出的 GUI；从窗口退出或 Cmd-Q 即停止宿主。

## 打包

```sh
pnpm --filter @deepseek-ai/dsh-desktop dist:mac
```

`dist:mac` 编译主进程，把自包含的 `dsh web` 运行时闭包暂存到 `dist/runtime`（`scripts/pack-runtime.mjs`），再运行 electron-builder。它在 `dist/mac-arm64/DeepSeek Harness.app` 产出原生 arm64 应用，并生成 `dist/DeepSeek Harness-<version>-arm64.dmg`。

打包后的应用把闭包（CLI、插件与已构建前端 dist）作为 extraResource 捆绑，并在 Electron 内置 Node 下运行 `dsh web`（`ELECTRON_RUN_AS_NODE=1`），因此无需仓库检出或系统 `node`。它是本地构建、未公证：electron-builder 在存在 Developer ID 证书时自动发现并签名（否则用 ad-hoc），分发给他人需要公证。

## 数据与凭证

该壳与终端里的 `dsh web` 共享宿主的 `DSH_HOME`（默认 `~/.dsh`）：会话记录、设置与凭证都存在那里，因此桌面应用看到的与浏览器 GUI 完全一致。该壳不引入任何隔离、也不复制任何数据——它只是拉起同一个宿主并加载其 URL。

## 测试

启动逻辑由 `tests/server.spec.ts` 覆盖：对端口/就绪/命令解析的单元覆盖，外加一个真实组合冒烟测试——真实启动 `dsh web` 宿主、断言其就绪 URL、并检查 GUI 通过 HTTP 响应。缺少已构建的 `apps/cli/lib/bin.js` 或 `apps/web/dist` 产物时，冒烟测试自跳过。

## 已知限制与推迟的工作

- **未公证。** `dist:mac` 不做公证；分发需要 Developer ID 签名与公证（electron-builder 自动发现身份，或用 `mac.identity` 显式指定）。
- **单窗口、单宿主。** 应用拥有一个窗口和它所拉起的那一个宿主子进程；它从不停止非它启动的宿主。
