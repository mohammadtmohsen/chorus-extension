import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = dirname(fileURLToPath(import.meta.url))
const dist = join(root, 'dist')

mkdirSync(dist, { recursive: true })

await build({
  entryPoints: [join(root, 'src', 'index.tsx')],
  outfile: join(dist, 'webview.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  minify: false,
  legalComments: 'none',
})

cpSync(join(root, 'src', 'styles.css'), join(dist, 'styles.css'))

process.stdout.write('built apps/webview/dist\n')
