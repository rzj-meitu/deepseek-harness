import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EPHEMERAL_PORT,
  parseReadyUrl,
  resolveCliBin,
  resolvePort,
  resolveRepoRoot,
  resolveServerCommand,
  spawnServer,
  stopServer,
  type RunningServer,
} from '../src/server.ts'

describe('resolvePort', () => {
  it('defaults to the ephemeral port', () => {
    expect(resolvePort({})).toBe(EPHEMERAL_PORT)
  })

  it('reads the DSH_WEB_PORT override', () => {
    expect(resolvePort({ DSH_WEB_PORT: '4173' })).toBe(4173)
  })

  it('rejects a non-numeric port', () => {
    expect(() => resolvePort({ DSH_WEB_PORT: 'abc' })).toThrow('DSH_WEB_PORT must be a port number')
  })
})

describe('parseReadyUrl', () => {
  it('extracts the URL from the readiness line', () => {
    expect(parseReadyUrl('dsh web: http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080')
  })

  it('stops at the LAN suffix', () => {
    expect(parseReadyUrl('dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)')).toBe('http://127.0.0.1:3080')
  })

  it('ignores unrelated lines', () => {
    expect(parseReadyUrl('[bundle] mounted a row')).toBeUndefined()
  })

  it('ignores a bare prefix with no URL', () => {
    expect(parseReadyUrl('dsh web:')).toBeUndefined()
  })
})

describe('resolveServerCommand', () => {
  it('spawns the built cli with the web profile and the port', () => {
    expect(resolveServerCommand({ nodeBin: 'node', cliBin: '/x/bin.js', cwd: '/repo', port: 4173 })).toEqual({
      command: 'node',
      args: ['/x/bin.js', 'web', '--port', '4173'],
      cwd: '/repo',
    })
  })

  it('defaults the port to the ephemeral one', () => {
    const cmd = resolveServerCommand({ nodeBin: 'node', cliBin: '/x/bin.js', cwd: '/repo' })
    expect(cmd.args).toEqual(['/x/bin.js', 'web', '--port', String(EPHEMERAL_PORT)])
  })
})

const built = existsSync(resolveCliBin()) && existsSync(resolve(resolveRepoRoot(), 'apps/web/dist/index.html'))

describe.skipIf(!built)('real host boot', () => {
  let running: RunningServer | undefined
  let home: string | undefined

  afterEach(async () => {
    if (running !== undefined) await stopServer(running.child)
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
    running = undefined
    home = undefined
  })

  it('boots dsh web, prints its readiness URL, and serves the GUI', { timeout: 60_000 }, async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-desktop-'))
    const command = resolveServerCommand({ port: 0 })
    running = spawnServer({ command, timeoutMs: 30_000, env: { ...process.env, DSH_HOME: home } })
    const url = await running.ready
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('DeepSeek Harness')
    await stopServer(running.child)
    running = undefined
  })
})
