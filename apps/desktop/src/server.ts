/**
 * Host-launch logic for the Electron desktop shell. This module owns how the
 * `dsh web` host is spawned and how its readiness line is observed, and imports
 * no `electron`, so the unit tests and the real-composition smoke test run
 * under plain Node.
 * @module @deepseek-ai/dsh-desktop/server
 */

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The line prefix `dsh web` prints once its server is bound and its routes are mounted. */
export const READY_LINE_PREFIX = 'dsh web: '

/**
 * The desktop shell asks the OS for a free port by default (`--port 0`), so it
 * never collides with a `dsh web` the user may already be running (the browser
 * surface's canonical URL is 3080). The window loads whatever URL the host
 * prints, so the concrete port is an internal detail.
 */
export const EPHEMERAL_PORT = 0

/**
 * The repo root, found by walking up from this file to the directory that
 * holds `pnpm-workspace.yaml`. The built artifact sits one level deeper than
 * the source (`lib/types` vs `src`), so a fixed hop count would only work from
 * one of them; the marker search is depth-independent.
 * @returns the absolute repo-root path.
 */
export function resolveRepoRoot(): string {
  let directory = fileURLToPath(new URL('.', import.meta.url))
  for (;;) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) return directory
    const parent = dirname(directory)
    if (parent === directory) {
      throw new Error('dsh-desktop: could not locate the repo root (no pnpm-workspace.yaml ancestor)')
    }
    directory = parent
  }
}

/**
 * The built `dsh` CLI entry (`apps/cli/lib/bin.js`), relative to the repo root.
 * @returns the absolute bin path.
 */
export function resolveCliBin(): string {
  return join(resolveRepoRoot(), 'apps', 'cli', 'lib', 'bin.js')
}

/**
 * The Node binary that runs the host child. `DSH_NODE_BIN` overrides for tests
 * and operators; the default `node` resolves through the caller's `PATH`.
 * @param env - the process environment to read the override from.
 */
export function resolveNodeBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_NODE_BIN ?? 'node'
}

/**
 * Resolve the launch port: the `DSH_WEB_PORT` override, else the ephemeral
 * default (`0`, so the OS picks a free port).
 * @param env - the process environment to read the override from.
 * @throws when the override is not a valid port number.
 */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DSH_WEB_PORT
  if (raw === undefined || raw === '') return EPHEMERAL_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`dsh-desktop: DSH_WEB_PORT must be a port number, got ${JSON.stringify(raw)}`)
  }
  return port
}

/** One ready-to-spawn host command. */
export interface ServerCommand {
  command: string
  args: string[]
  cwd: string
}

/** Options for {@link resolveServerCommand}. */
export interface ResolveServerCommandOptions {
  port?: number
  nodeBin?: string
  cliBin?: string
  cwd?: string
}

/**
 * Resolve the `dsh web` spawn for a port: `<node> <cliBin> web --port <port>`,
 * run from the repo root so profile and node_modules resolution matches an
 * interactive `dsh web` exactly.
 * @param options - port and the path overrides tests substitute.
 */
export function resolveServerCommand(options: ResolveServerCommandOptions = {}): ServerCommand {
  const port = options.port ?? EPHEMERAL_PORT
  return {
    command: options.nodeBin ?? resolveNodeBin(),
    args: [options.cliBin ?? resolveCliBin(), 'web', '--port', String(port)],
    cwd: options.cwd ?? resolveRepoRoot(),
  }
}

/**
 * Extract the canonical local URL from a `dsh web: http://…` readiness line.
 * @param line - one line of the child's stdout.
 * @returns the URL, or `undefined` when the line is not the readiness line.
 */
export function parseReadyUrl(line: string): string | undefined {
  if (!line.startsWith(READY_LINE_PREFIX)) return undefined
  const rest = line.slice(READY_LINE_PREFIX.length).trim()
  return rest.match(/^https?:\/\/\S+/)?.[0]
}

/** A spawned host and the promise of its readiness URL. */
export interface RunningServer {
  child: ChildProcess
  /** Resolves with the canonical URL once the readiness line prints; rejects on timeout or early exit. */
  ready: Promise<string>
}

/** Options for {@link spawnServer}. */
export interface SpawnServerOptions {
  command?: ServerCommand
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

/**
 * Spawn the host child and observe its stdout for the readiness line. The
 * returned `ready` promise rejects when the child exits first or the timeout
 * elapses, so the caller surfaces a boot failure instead of loading a dead URL.
 * @param options - the command to spawn, its readiness timeout, and its environment.
 */
export function spawnServer(options: SpawnServerOptions = {}): RunningServer {
  const command = options.command ?? resolveServerCommand()
  const timeoutMs = options.timeoutMs ?? 30_000
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env ?? process.env,
  })
  const ready = new Promise<string>((resolve, reject) => {
    let buffer = ''
    let stderr = ''
    const state = { settled: false, timer: undefined as ReturnType<typeof setTimeout> | undefined }

    const onStdout = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const url = parseReadyUrl(line)
        if (url !== undefined) settle(() => { resolve(url) })
      }
    }
    const onStderr = (chunk: Buffer): void => { stderr += chunk.toString('utf8') }
    const onExit = (code: number | null): void => {
      settle(() => { reject(new Error(`dsh-desktop: host exited before ready (code ${String(code)}): ${stderr.trim()}`)) })
    }
    const onError = (error: Error): void => { settle(() => { reject(error) }) }

    const cleanup = (): void => {
      if (state.timer !== undefined) clearTimeout(state.timer)
      child.stdout.removeListener('data', onStdout)
      child.stderr.removeListener('data', onStderr)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
    }
    const settle = (action: () => void): void => {
      if (state.settled) return
      state.settled = true
      cleanup()
      action()
    }

    state.timer = setTimeout(() => {
      settle(() => { reject(new Error(`dsh-desktop: host did not become ready within ${timeoutMs}ms`)) })
    }, timeoutMs)
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.on('exit', onExit)
    child.on('error', onError)
  })
  return { child, ready }
}

/**
 * Stop a host child: SIGTERM for a graceful dispose, then SIGKILL if it
 * lingers past the grace window. Resolves once the child has exited.
 * @param child - the host child, or `undefined` (a no-op).
 * @param graceMs - how long to wait for a graceful exit before SIGKILL.
 */
export async function stopServer(child: ChildProcess | undefined, graceMs = 5_000): Promise<void> {
  if (child === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, graceMs)
    child.once('exit', () => {
      clearTimeout(killTimer)
      resolve()
    })
  })
}
