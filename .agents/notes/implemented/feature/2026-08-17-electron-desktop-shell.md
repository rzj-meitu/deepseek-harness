# Agent Note: Electron desktop shell — the macOS app wraps the dsh web host in a native window

Status: implemented

English | [中文](2026-08-17-electron-desktop-shell.zh.md)

## Problem

The DeepSeek Harness GUI is a browser surface served by `dsh web`: a user runs `dsh web`, the host prints a URL, and the platform browser loads it. There is no desktop app — no Dock icon, no dedicated window, no single gesture that launches the session and tears the host down with it. The [GUI layering note](../architecture/2026-07-19-gui-layering-and-rpc-protocol.md) already reserved the desktop slot, and its carrier table names a hypothetical Electron IPC bridge, but no shell existed.

## Decision

Ship `apps/desktop` (`@deepseek-ai/dsh-desktop`), a macOS Electron shell that does not reimplement the GUI and does not introduce the IPC bridge. Its main process spawns the same `dsh web` host a terminal user would (`node apps/cli/lib/bin.js web --port <port>`), waits for the host's `dsh web: http://…` readiness line, then loads that URL in a `BrowserWindow`. Closing the window stops the host and quits.

- `src/server.ts` holds the pure launch logic — command resolution, readiness-line parsing, graceful stop — with no `electron` import, so it tests under plain Node.
- `src/main.ts` is the Electron entry: spawn → await ready → window → `window-all-closed` → `before-quit` stops the child → quit.
- The shell asks the OS for a free port by default (`--port 0`), so it never collides with a `dsh web` already running; `DSH_WEB_PORT` pins one. The host runs under the node binary `DSH_NODE_BIN` resolves (default `node` on `PATH`).
- The shell shares the host's `DSH_HOME` (default `~/.dsh`): session records, settings, and credentials sync with a terminal `dsh web`; the shell adds no isolation and copies nothing.
- `tests/server.spec.ts` unit-covers the pure logic and adds a real-composition smoke test that boots the actual host, asserts its readiness URL, and checks the GUI responds over HTTP; it self-skips without the built artifacts.
- A packaged app (electron-builder, arm64) runs the same host under Electron's bundled Node (`ELECTRON_RUN_AS_NODE=1`) from a self-contained runtime closure staged into `dist/runtime` and shipped as an extraResource. `scripts/pack-runtime.mjs` materializes that closure with `pnpm deploy --legacy`, dereferences the `link:`-overridden vendored packages (`@deepseek-ai/cosmokit`, `@deepseek-ai/schemastery`) so the closure is genuinely self-contained, and swaps the arch-specific native packages (koffi, sharp, sharp-libvips, ripgrep, node-addon-require-builtin) to arm64 — the deploy resolves x64 because the agent shell runs under Rosetta while Electron is arm64. The packaged child runs with `--expose-internals` because Electron's bundled Node does not honor the web profile's `disabled: true` HMR override at boot (a system Node does), and the base profile's HMR service constructor requires that flag.

## Alternatives considered

### Why not the IPC bridge (`file://` + in-process host)?

The layering note's "future Electron" form loads `dist` over `file://` and carries fetch over an Electron IPC `doFetch` subclass, with the host in-process. It needs a new transport subclass, an in-process host assembly under Electron's Node (recompiling native addons against Electron's ABI), and gives up the HTTP/WebSocket carriage for no immediate benefit. The goal was a desktop shell, not a second client carrier; the HTTP-server approach reuses everything unchanged and remains one transport seam away from that form later.

### Why not Tauri?

Tauri's backend is Rust; the host is Node, so Tauri would still bundle and spawn a Node runtime to run `dsh web`, adding a second runtime without removing any Electron-specific work. Electron's main process is already Node, matching the host runtime.

### Why not a native AppKit launcher that opens the system browser?

A minimal Swift/AppKit app that launches `dsh web` and opens the default browser gives a Dock icon but not a real window — the GUI still lives in the browser. The desktop shell replaces the browser with its own window, which is the point.

## Consequences

A macOS desktop shell exists that launches, loads, and tears down the host as one unit, reusing the web host and frontend unchanged. `dist:mac` now produces a self-contained arm64 `.app`/`.dmg` (the closure bundles the CLI, plugins, and frontend dist, and runs under Electron's bundled Node), so no repository checkout or system Node is needed; the packaged app shares `~/.dsh` with a terminal `dsh web`. The deferred cost is distribution signing: the build is not notarized, so shipping to others needs a Developer ID signature and notarization, and the shell is single-window/single-host.

## Testing

- `server.spec.ts` unit-covers port/readiness/command resolution and runs a real host boot that asserts the readiness URL and an HTTP 200 GUI response.
- `tsconfig.host.json` references `apps/desktop`, so `pnpm run typecheck` covers the Electron main process.
