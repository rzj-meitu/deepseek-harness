/**
 * Regenerate the Electron desktop runtime manifest's `dependencies` from the
 * authoritative web-runtime seeds. A dsh update renames, splits, and removes
 * workspace packages; this script recomputes the seed set so the deploy root
 * never points at a renamed or removed package.
 *
 * The manifest is a seed list, not a full closure: `pnpm deploy --legacy`
 * materializes the transitive workspace closure from these seeds (see
 * scripts/pack-runtime.mjs). The seeds are:
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
 * It deletes any `@deepseek-ai/*` dependency that no longer exists in the
 * workspace and writes the result back sorted, so the output is canonical and
 * the diff after a dsh update is exactly the package renames/splits.
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
 * Compute the seed set from the current workspace.
 * @param {Map<string, any>} workspace package name -> manifest.
 * @returns {Set<string>} workspace package names that must be listed as seeds.
 */
function collectSeeds(workspace) {
  const seeds = new Set(ALWAYS_SEEDS)

  const addDeps = (manifestPath) => {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(resolve(repoRoot, manifestPath), 'utf8'))
    } catch {
      return
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (workspace.has(name)) seeds.add(name)
    }
  }
  addDeps('apps/cli/package.json')
  addDeps('packages/bundle/web-app/package.json')

  for (const [name, manifest] of workspace) {
    if (manifest.dsh?.client) seeds.add(name)
  }
  return seeds
}

const workspace = collectWorkspacePackages()
const seeds = collectSeeds(workspace)

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const current = new Set(Object.keys(manifest.dependencies ?? {}))

const next = new Set(current)
for (const name of current) {
  if (name.startsWith('@deepseek-ai/') && !workspace.has(name)) next.delete(name)
}
for (const name of seeds) next.add(name)

manifest.dependencies = Object.fromEntries(
  [...next].sort().map((name) => [name, 'workspace:^']),
)
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

const removed = [...current].filter((name) => !next.has(name)).length
const added = [...next].filter((name) => !current.has(name)).length
console.log(
  `refresh-runtime-manifest: ${current.size} -> ${next.size} seeds (removed ${removed}, added ${added})`,
)
