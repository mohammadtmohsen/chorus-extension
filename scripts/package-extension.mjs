import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const extensionRoot = join(root, 'apps', 'extension')
const engineRoot = join(root, 'apps', 'engine')
const enginePayload = join(extensionRoot, 'engine')

const NATIVE_MODULE = 'better-sqlite3'
const NATIVE_KEEP = ['lib', 'prebuilds', 'package.json']

const currentTarget = () => `${process.platform}-${process.arch}`

function findNativeModule() {
  const store = join(root, 'node_modules', '.pnpm')
  const entry = readdirSync(store).find((name) => name.startsWith(`${NATIVE_MODULE}@`))
  if (entry === undefined) throw new Error(`${NATIVE_MODULE} is not installed`)
  return join(store, entry, 'node_modules', NATIVE_MODULE)
}

async function bundle() {
  await build({
    entryPoints: [join(extensionRoot, 'src', 'extension.ts')],
    outfile: join(extensionRoot, 'dist', 'extension.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['vscode'],
    legalComments: 'none',
  })

  rmSync(enginePayload, { recursive: true, force: true })
  await build({
    entryPoints: [join(engineRoot, 'src', 'main.ts')],
    outfile: join(enginePayload, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: [NATIVE_MODULE],
    legalComments: 'none',
  })
}

function placeNativeModule() {
  const source = findNativeModule()
  const target = join(enginePayload, 'node_modules', NATIVE_MODULE)
  mkdirSync(target, { recursive: true })
  for (const name of NATIVE_KEEP) {
    cpSync(join(source, name), join(target, name), { recursive: true })
  }

  const prebuilds = join(target, 'prebuilds')
  const keep = `${currentTarget()}.node`
  for (const name of readdirSync(prebuilds)) {
    if (name !== keep) rmSync(join(prebuilds, name), { force: true })
  }
}

function placeWebview() {
  const target = join(extensionRoot, 'webview')
  rmSync(target, { recursive: true, force: true })
  cpSync(join(root, 'apps', 'webview', 'dist'), target, { recursive: true })
}

function stripTypeScriptOutput() {
  const dist = join(extensionRoot, 'dist')
  for (const name of readdirSync(dist)) {
    if (name === 'extension.js') continue
    rmSync(join(dist, name), { recursive: true, force: true })
  }
}

function packageVsix() {
  const out = join(root, 'chorus-collaboration.vsix')
  if (existsSync(out)) rmSync(out)
  execFileSync(
    'pnpm',
    [
      'exec',
      'vsce',
      'package',
      '--no-dependencies',
      '--allow-missing-repository',
      '--target',
      currentTarget(),
      '--out',
      out,
    ],
    { cwd: extensionRoot, stdio: 'inherit' }
  )
  return out
}

await bundle()
placeNativeModule()
placeWebview()
stripTypeScriptOutput()
const vsix = packageVsix()
process.stdout.write(`packaged ${vsix}\n`)
