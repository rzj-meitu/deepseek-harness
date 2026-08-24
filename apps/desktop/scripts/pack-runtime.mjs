/**
 * Stage the dsh web runtime closure for the Electron desktop shell into
 * `apps/desktop/dist/runtime`, which electron-builder bundles as an
 * extraResource. The closure is the `dsh-desktop-runtime` deploy root (a pure
 * dependency manifest under apps/desktop/runtime) materialized by `pnpm deploy`.
 *
 * `pnpm deploy --legacy` hoists normal workspace packages but leaves the
 * `link:`-overridden vendored packages (`@deepseek-ai/cosmokit`,
 * `@deepseek-ai/schemastery`) beside the deploy source, so this script restores
 * any direct dependency the deploy omitted from the deploy root's own
 * node_modules. See scripts/verify-runtime-closure.ts for the closure gate.
 *
 * The deploy resolves arch-specific native packages (koffi, sharp, sharp-libvips,
 * ripgrep, node-addon-require-builtin) for the arch of the Node running pnpm.
 * On an Apple Silicon host whose shell runs under Rosetta that is x64, while the
 * bundled Electron is arm64, so this script swaps every `*-darwin-x64` package
 * for its `*-darwin-<arch>` twin at the same version (node-pty ships both archs
 * in one package and needs no swap). Set DSH_DESKTOP_ARCH to override the target
 * arch (default: arm64).
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopDir, '..', '..')
const deployRoot = 'dsh-desktop-runtime'
const target = join(desktopDir, 'dist', 'runtime')
const targetArch = process.env.DSH_DESKTOP_ARCH ?? 'arm64'

/** Run a command from the repo root and fail the process on nonzero exit. */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

/** Copy direct dependencies the legacy deploy left beside the deploy source. */
function restoreMissingDirectDependencies() {
  const manifest = JSON.parse(readFileSync(join(desktopDir, 'runtime', 'package.json'), 'utf8'))
  const sourceNodeModules = join(desktopDir, 'runtime', 'node_modules')
  const restored = []
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(target, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) continue
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true, dereference: true })
    restored.push(dependency)
  }
  if (restored.length > 0) {
    console.log(`pack-runtime: restored legacy-deploy omissions: ${restored.join(', ')}`)
  }
}

/**
 * Replace every `node_modules` symlink that resolves outside the staged tree
 * with a real copy of its target, recursively. `pnpm deploy --legacy` keeps the
 * `link:`-overridden vendored packages (`@deepseek-ai/cosmokit`,
 * `@deepseek-ai/schemastery`) as symlinks into the checkout, so the staged
 * closure is only self-contained after these are dereferenced. Nested symlinks
 * that no longer resolve after the copy are dropped so Node resolution falls
 * back to the flat hoisted `node_modules`.
 */
function dereferenceExternalSymlinks() {
  const root = join(target, 'node_modules')
  const dereferenced = []
  const dropped = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        let real
        try {
          real = realpathSync(full)
        } catch {
          rmSync(full)
          dropped.push(relative(root, full))
          continue
        }
        if (real === target || real.startsWith(target + sep)) continue
        rmSync(full)
        cpSync(real, full, { recursive: true })
        dereferenced.push(relative(root, full))
        walk(full)
      } else if (entry.isDirectory()) {
        walk(full)
      }
    }
  }
  walk(root)
  if (dereferenced.length > 0) {
    console.log(`pack-runtime: dereferenced workspace symlinks: ${dereferenced.join(', ')}`)
  }
  if (dropped.length > 0) {
    console.log(`pack-runtime: dropped broken symlinks (resolve from flat node_modules): ${dropped.join(', ')}`)
  }
}

/** Download `fullName@version` from the npm registry and extract into `destDir`. */
function downloadPackage(fullName, version, destDir) {
  const encoded = fullName.split('/').map(encodeURIComponent).join('/')
  const meta = JSON.parse(execFileSync('curl', ['-sL', `https://registry.npmjs.org/${encoded}/${version}`]).toString())
  const bytes = execFileSync('curl', ['-sL', meta.dist.tarball], { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' })
  mkdirSync(destDir, { recursive: true })
  const tar = spawnSync('tar', ['-xz', '--strip-components=1', '-C', destDir], {
    input: bytes,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  if (tar.status !== 0) throw new Error(`pack-runtime: failed to extract ${fullName}@${version}`)
}

/** Swap every `*-darwin-<otherArch>` native package for the `-<targetArch>` twin. */
function swapArchSpecificPackages() {
  const otherArch = targetArch === 'arm64' ? 'x64' : 'arm64'
  const otherSuffix = `darwin-${otherArch}`
  const targetSuffix = `darwin-${targetArch}`
  const nodeModules = join(target, 'node_modules')
  const swapped = []

  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.includes(otherSuffix)) {
      swapped.push(join(nodeModules, entry.name))
    } else if (entry.isDirectory() && entry.name.startsWith('@')) {
      for (const sub of readdirSync(join(nodeModules, entry.name), { withFileTypes: true })) {
        if (sub.name.includes(otherSuffix)) swapped.push(join(nodeModules, entry.name, sub.name))
      }
    }
  }

  for (const dir of swapped) {
    const fullName = relative(nodeModules, dir).split('\\').join('/')
    const targetName = fullName.replace(otherSuffix, targetSuffix)
    const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
    const destDir = join(nodeModules, ...targetName.split('/'))
    downloadPackage(targetName, version, destDir)
    rmSync(dir, { recursive: true, force: true })
    console.log(`pack-runtime: swapped ${fullName} -> ${targetName}@${version}`)
  }
}

rmSync(target, { recursive: true, force: true })
run('pnpm', [
  '--filter',
  deployRoot,
  'deploy',
  '--legacy',
  '--prod',
  '--config.node-linker=hoisted',
  '--config.auto-install-peers=true',
  '--config.link-workspace-packages=true',
  target,
])
restoreMissingDirectDependencies()
dereferenceExternalSymlinks()
swapArchSpecificPackages()
for (const name of ['README.md', 'README.zh.md', 'README.i18n.yaml']) {
  rmSync(join(target, name), { force: true })
}

const entry = join(target, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const dist = join(target, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
if (!existsSync(entry)) {
  console.error(`pack-runtime: ${entry} is missing — the deployed closure has no dsh CLI entry.`)
  process.exit(1)
}
if (!existsSync(dist)) {
  console.error(`pack-runtime: ${dist} is missing — run pnpm run build first so apps/web/dist exists.`)
  process.exit(1)
}
console.log(`pack-runtime: staged the dsh web runtime at ${target} (target arch: ${targetArch})`)
