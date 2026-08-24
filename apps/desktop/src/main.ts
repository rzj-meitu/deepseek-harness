/**
 * Electron main process for the DeepSeek Harness desktop shell: spawns the
 * `dsh web` host, waits for its readiness line, then loads the local HTTP
 * surface in a native window. Closing the window stops the host and quits.
 * @module @deepseek-ai/dsh-desktop
 */

import { app, BrowserWindow, dialog } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveServerCommand, spawnServer, stopServer, type RunningServer, type ServerCommand } from './server.ts'

/** The live host child, set once boot begins. */
let server: RunningServer | undefined
/** Whether a quit is already tearing the host down (guards re-entrant quit). */
let quitting = false

/**
 * Resolve the host spawn for the current app. A packaged app bundles the dsh
 * web runtime as an extraResource and runs it under Electron's bundled Node
 * (`ELECTRON_RUN_AS_NODE=1`), so it needs no repository checkout or system
 * `node`; a dev run resolves the checkout's `apps/cli/lib/bin.js` on `PATH`.
 * @returns the spawn command and the child environment.
 */
function resolveLaunch(): { command: ServerCommand; env: NodeJS.ProcessEnv } {
  if (!app.isPackaged) {
    return { command: resolveServerCommand(), env: process.env }
  }
  const cliBin = join(
    process.resourcesPath,
    'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
  )
  const command = resolveServerCommand({ nodeBin: process.execPath, cliBin, cwd: homedir() })
  // The base profile always mounts the HMR service, whose constructor needs
  // Node's `--expose-internals`. Under Electron's bundled Node the web
  // profile's `disabled` override is not honored at boot (it is under a system
  // Node), so the packaged child runs with the flag to keep the mount valid.
  return {
    command: { ...command, args: ['--expose-internals', ...command.args] },
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }
}

/**
 * Create the single application window and load the host URL. The renderer is
 * the served GUI (a normal web page), so no preload or Node integration.
 * @param url - the canonical local URL the host printed.
 */
function createWindow(url: string): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'DeepSeek Harness',
  })
  void win.loadURL(url)
}

/**
 * Surface a fatal boot failure and quit. A hidden console error must not leave
 * the window on a dead URL or strand the user.
 * @param error - the boot failure.
 */
function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox('DeepSeek Harness failed to start', message)
  app.quit()
}

void app.whenReady().then(() => {
  const launch = resolveLaunch()
  const spawned = spawnServer({ command: launch.command, env: launch.env })
  server = spawned
  // If the host dies on its own after boot (crash, manual kill), the window
  // has nothing to talk to — quit rather than show a dead page.
  spawned.child.on('exit', () => {
    if (!quitting) app.quit()
  })
  spawned.ready.then(
    (url) => { createWindow(url) },
    (error: unknown) => { fail(error) },
  )
})

// Closing the only window ends the session: quit, and let `before-quit` stop
// the host so it never lingers on the port after its window is gone.
app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', (event) => {
  const child = server?.child
  if (child === undefined || quitting) return
  if (child.exitCode !== null || child.signalCode !== null) return
  event.preventDefault()
  quitting = true
  void stopServer(child).finally(() => { app.quit() })
})
