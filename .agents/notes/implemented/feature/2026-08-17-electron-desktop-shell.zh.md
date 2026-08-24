# Agent Note: Electron 桌面壳 —— macOS 应用将 dsh web 宿主装进原生窗口

Status: implemented

[English](2026-08-17-electron-desktop-shell.md) | 中文

## Problem

DeepSeek Harness 的 GUI 是由 `dsh web` 提供服务的浏览器界面：用户运行 `dsh web`，宿主打印一个 URL，再由系统浏览器加载它。这里没有桌面应用——没有 Dock 图标、没有独立窗口、没有一个动作就能启动会话并随之关闭宿主的入口。[GUI 分层说明](../architecture/2026-07-19-gui-layering-and-rpc-protocol.md) 已经为桌面端预留了位置，其 carrier 表也列出了一个假想的 Electron IPC 桥，但尚无任何壳实现。

## Decision

交付 `apps/desktop`（`@deepseek-ai/dsh-desktop`），一个 macOS Electron 壳：它不重写 GUI，也不引入 IPC 桥。其主进程拉起与终端用户完全相同的 `dsh web` 宿主（`node apps/cli/lib/bin.js web --port <port>`），等待宿主的 `dsh web: http://…` 就绪行，然后把该 URL 加载进一个 `BrowserWindow`。关闭窗口即停止宿主并退出。

- `src/server.ts` 持有纯启动逻辑——命令解析、就绪行解析、优雅停止——不引入 `electron` 依赖，因此可在纯 Node 下测试。
- `src/main.ts` 是 Electron 入口：拉起 → 等待就绪 → 窗口 → `window-all-closed` → `before-quit` 停止子进程 → 退出。
- 该壳默认向 OS 申请空闲端口（`--port 0`），因此不会与已在运行的 `dsh web` 冲突；`DSH_WEB_PORT` 可固定端口。宿主运行在 `DSH_NODE_BIN` 解析出的 node 二进制下（默认取 `PATH` 中的 `node`）。
- 该壳与终端里的 `dsh web` 共享宿主的 `DSH_HOME`（默认 `~/.dsh`）：会话记录、设置与凭证都同步；该壳不引入任何隔离、也不复制任何数据。
- `tests/server.spec.ts` 对纯逻辑做单元覆盖，并带一个真实组合冒烟测试：真实启动宿主、断言其就绪 URL、并检查 GUI 通过 HTTP 响应；缺少构建产物时自跳过。
- 打包应用（electron-builder，arm64）在 Electron 内置 Node 下（`ELECTRON_RUN_AS_NODE=1`）运行同一个宿主，运行时取自暂存进 `dist/runtime` 并作为 extraResource 打包的自包含闭包。`scripts/pack-runtime.mjs` 用 `pnpm deploy --legacy` 物化该闭包，把 `link:` 覆盖的 vendored 包（`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery`）解引用以使其真正自包含，并把按架构区分的原生包（koffi、sharp、sharp-libvips、ripgrep、node-addon-require-builtin）换成 arm64——因为 agent shell 跑在 Rosetta 下、deploy 解析出 x64，而 Electron 是 arm64。打包子进程以 `--expose-internals` 运行：Electron 内置 Node 在启动时不遵守 web profile 的 `disabled: true` HMR 覆盖（系统 Node 会遵守），而基础 profile 的 HMR 服务构造器需要该标志。

## Alternatives considered

### Why not the IPC 桥（`file://` + 进程内宿主）?

分层说明中的“未来 Electron”形态是：通过 `file://` 加载 `dist`，用一个 Electron IPC 的 `doFetch` 子类承载 fetch，宿主运行在进程内。它需要新的传输子类、在 Electron 的 Node 下做进程内宿主装配（要按 Electron 的 ABI 重新编译原生插件），并白白放弃 HTTP/WebSocket 承载。目标是桌面壳，不是第二个客户端 carrier；HTTP 服务器方案原样复用一切，并只距该形态一个传输 seam。

### Why not Tauri?

Tauri 的后端是 Rust；而宿主是 Node，所以 Tauri 仍要捆绑并拉起一个 Node 运行时来跑 `dsh web`，平添第二个运行时却省不掉任何 Electron 专属的工作。Electron 的主进程本身就是 Node，与宿主运行时一致。

### Why not 一个打开系统浏览器的原生 AppKit 启动器?

一个拉起 `dsh web` 并打开默认浏览器的最小 Swift/AppKit 应用只给出 Dock 图标，却没有真正的窗口——GUI 仍活在浏览器里。桌面壳用自己的窗口替代浏览器，这正是本意。

## Consequences

存在一个 macOS 桌面壳，把宿主的启动、加载与回收作为一个整体完成，原样复用 Web 宿主与前端。`dist:mac` 现在产出自包含的 arm64 `.app`/`.dmg`（闭包捆绑 CLI、插件与前端 dist，并在 Electron 内置 Node 下运行），因此无需仓库检出或系统 Node；打包应用与终端里的 `dsh web` 共享 `~/.dsh`。推迟的代价是分发签名：该构建未公证，因此分发给他人需要 Developer ID 签名与公证，且该壳是单窗口/单宿主。

## Testing

- `server.spec.ts` 对端口/就绪/命令解析做单元覆盖，并跑一个真实宿主启动，断言就绪 URL 与 HTTP 200 的 GUI 响应。
- `tsconfig.host.json` 引用了 `apps/desktop`，因此 `pnpm run typecheck` 覆盖了 Electron 主进程。
