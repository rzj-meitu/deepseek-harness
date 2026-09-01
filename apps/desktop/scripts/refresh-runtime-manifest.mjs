/**
 * Regenerate the Electron desktop runtime manifest's `dependencies` from the
 * authoritative web-runtime seeds. A dsh update renames, splits, and removes
 * workspace packages; this script recomputes the seed set so the deploy root
 * never points at a renamed or removed package.
 *
 * The manifest lists the full runtime closure. `pnpm deploy --legacy`
 * materializes transitive `dependencies`, but with auto peer installation
 * disabled it does NOT install required `peerDependencies` (see
 * scripts/verify-runtime-closure.ts). So the closure walks dependencies,
 * optionalDependencies, and non-optional peerDependencies from these roots:
 *
 * - the `dsh` CLI host package itself (`@deepseek-ai/dsh`, the `apps/cli`
 *   entry the shell spawns),
 * - every workspace dependency of `apps/cli` (the host plugin spine),
 * - every workspace dependency of `packages/bundle/web-app` (the web bundle),
 * - every package declaring `dsh.client` (client plugins the loader pulls in
 *   at runtime, absent from any package.json dependency edge),
 * - the platform singletons the client shell shares into its frozen module
 *   table (`dsh-client-ui-slots`, `dsh-client-ui-primitives`).
 *
 * It writes the closure back sorted, so the output is canonical and the diff
 * after a dsh update is exactly the package renames/splits.
 *
 * Run it before `pnpm install`; it is safe to run repeatedly (idempotent).
 */
import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopDir, '..', '..')
const manifestPath = resolve(desktopDir, 'runtime', 'package.json')

/** Platform singletons and the CLI entry: reachable through no dependency edge. */
const ALWAYS_SEEDS = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** pnpm-workspace.yaml package globs, mirrored as package.json patterns. */
const WORKSPACE_GLOBS = [
  'vendor/*/package.json',
  'packages/*/*/package.json',
  'native/landlock-run/package.json',
  'native/landlock-run/packages/*/package.json',
  'apps/*/package.json',
  'apps/*/*/package.json',
  'website/package.json',
  'examples/package.json',
  'python/sdk-runtime/package.json',
]

/** True for build-artifact paths that must never be read as packages. */
function isIgnored(file) {
  return /(^|\/)(node_modules|dist|lib|\.cache|\.artifacts)\//.test(file)
}

/** Read every workspace package.json keyed by name. */
function collectWorkspacePackages() {
  const byName = new Map()
  for (const pattern of WORKSPACE_GLOBS) {
    for (const file of globSync(pattern, { cwd: repoRoot })) {
      if (isIgnored(file)) continue
      let manifest
      try {
        manifest = JSON.parse(readFileSync(resolve(repoRoot, file), 'utf8'))
      } catch {
        continue
      }
      if (manifest.name) byName.set(manifest.name, manifest)
    }
  }
  return byName
}

/**
 * Compute the runtime closure from the current workspace.
 * @param {Map<string, any>} workspace package name -> manifest.
 * @returns {Set<string>} every workspace package reachable from the roots
 *   through dependencies, optionalDependencies, and required peers.
 */
function computeClosure(workspace) {
  const roots = new Set(ALWAYS_SEEDS)

  const addDeps = (manifestPath) => {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(resolve(repoRoot, manifestPath), 'utf8'))
    } catch {
      return
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) roots.add(name)
  }
  addDeps('apps/cli/package.json')
  addDeps('packages/bundle/web-app/package.json')

  for (const [name, manifest] of workspace) {
    if (manifest.dsh?.client) roots.add(name)
  }

  const closure = new Set()
  const queue = []
  const add = (name) => {
    if (!workspace.has(name) || closure.has(name)) return
    closure.add(name)
    queue.push(name)
  }
  for (const root of roots) add(root)

  for (let index = 0; index < queue.length; index += 1) {
    const manifest = workspace.get(queue[index])
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    }
    for (const dependency of Object.keys(dependencies)) add(dependency)
    const peers = manifest.peerDependencies ?? {}
    const peerMeta = manifest.peerDependenciesMeta ?? {}
    for (const peer of Object.keys(peers)) {
      if (peerMeta[peer]?.optional === true) continue
      add(peer)
    }
  }
  return closure
}

const workspace = collectWorkspacePackages()
const seeds = computeClosure(workspace)

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const current = new Set(Object.keys(manifest.dependencies ?? {}))

const next = seeds

manifest.dependencies = Object.fromEntries(
  [...next].sort().map((name) => [name, 'workspace:^']),
)
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

const removed = [...current].filter((name) => !next.has(name)).length
const added = [...next].filter((name) => !current.has(name)).length
console.log(
  `refresh-runtime-manifest: ${current.size} -> ${next.size} seeds (removed ${removed}, added ${added})`,
)
