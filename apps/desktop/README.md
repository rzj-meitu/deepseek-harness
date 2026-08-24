# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

The DeepSeek Harness desktop shell: an Electron application (macOS) that wraps the existing browser GUI in a native window. It does not reimplement the GUI — it spawns the same `dsh web` host a terminal user would, waits for the host's readiness line, then loads the served surface in an Electron `BrowserWindow`. Closing the window stops the host and quits.

## How it works

The main process ([`src/main.ts`](src/main.ts)) runs the host as a child and owns the window lifecycle; [`src/server.ts`](src/server.ts) holds the pure launch logic (command resolution, readiness-line parsing, graceful stop) with no `electron` import so it can be tested under plain Node.

- `resolveServerCommand` runs `<node> apps/cli/lib/bin.js web --port <port>` from the repo root — exactly the `dsh web` invocation, so profiles, node_modules, and the built frontend dist resolve the same way.
- `spawnServer` observes the child's stdout for the `dsh web: http://…` readiness line (the same signal supervisors use) and resolves with the canonical URL; the window loads only after the server is bound and its routes are mounted.
- The shell asks the OS for a free port by default, so it never collides with a `dsh web` already running (`DSH_WEB_PORT` pins a port); the host runs under the node binary resolved by `DSH_NODE_BIN` (default: `node` on `PATH`).

## Run

```sh
# Build the host + frontend artifacts once, then launch the desktop shell.
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop dev
```

`dev` compiles the main process (`tsc`) and launches Electron. The window shows the served GUI; quit from the window or Cmd-Q stops the host.

## Package

```sh
pnpm --filter @deepseek-ai/dsh-desktop dist:mac
```

`dist:mac` builds the main process, stages the self-contained `dsh web` runtime closure into `dist/runtime` (`scripts/pack-runtime.mjs`), then runs electron-builder. It produces a native arm64 app at `dist/mac-arm64/DeepSeek Harness.app` and a `dist/DeepSeek Harness-<version>-arm64.dmg`.

The packaged app bundles the closure (CLI, plugins, and the built frontend dist) as an extraResource and runs `dsh web` under Electron's bundled Node (`ELECTRON_RUN_AS_NODE=1`), so it needs no repository checkout or system `node`. It is a local build and is not notarized: electron-builder signs with an auto-discovered Developer ID when present (ad-hoc otherwise), and distributing it needs notarization.

## Data and credentials

The shell shares the host's `DSH_HOME` (default `~/.dsh`) with a terminal `dsh web`: session records, settings, and credentials live there, so the desktop app sees exactly what the browser GUI sees. The shell adds no isolation and copies nothing — it only spawns the same host and loads its URL.

## Test

The launch logic is covered by `tests/server.spec.ts`: unit coverage for port/readiness/command resolution, plus a real-composition smoke test that boots the actual `dsh web` host, asserts its readiness URL, and checks the GUI responds over HTTP. The smoke test self-skips when the built `apps/cli/lib/bin.js` or `apps/web/dist` artifacts are absent.

## Known Limitations and Deferred Work

- **Not notarized.** `dist:mac` does not notarize the app; distributing it needs a Developer ID signature and notarization (electron-builder auto-discovers the identity, or `mac.identity` selects it explicitly).
- **Single window, single host.** The app owns one window and the one host child it spawned; it never stops a host it did not start.
