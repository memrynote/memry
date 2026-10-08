// Copies KaTeX and mermaid into apps/ios/Memry/Resources/BlockRender.bundle,
// the page the shared block renderer loads (BlockWebRenderer.swift). Both come
// from the copies desktop resolves, so iOS typesets with the same versions.
//
//   node apps/ios/scripts/generate-block-render.mjs
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const desktop = createRequire(path.join(root, 'apps/desktop/package.json'))
const katex = path.dirname(desktop.resolve('katex/package.json'))
const streamdown = createRequire(
  path.join(root, 'apps/desktop/node_modules/@streamdown/mermaid/package.json')
)
const mermaid = path.dirname(streamdown.resolve('mermaid/package.json'))

const out = path.join(root, 'apps/ios/Memry/Resources/BlockRender.bundle')
rmSync(path.join(out, 'vendor'), { recursive: true, force: true })
mkdirSync(path.join(out, 'vendor/fonts'), { recursive: true })

copyFileSync(path.join(katex, 'dist/katex.min.js'), path.join(out, 'vendor/katex.min.js'))
copyFileSync(path.join(katex, 'dist/katex.min.css'), path.join(out, 'vendor/katex.min.css'))
copyFileSync(path.join(katex, 'LICENSE'), path.join(out, 'vendor/katex.LICENSE'))
// WebKit takes the first source in each @font-face, which is the woff2.
const fonts = readdirSync(path.join(katex, 'dist/fonts')).filter((name) => name.endsWith('.woff2'))
for (const font of fonts) {
  copyFileSync(path.join(katex, 'dist/fonts', font), path.join(out, 'vendor/fonts', font))
}
copyFileSync(path.join(mermaid, 'dist/mermaid.min.js'), path.join(out, 'vendor/mermaid.min.js'))
copyFileSync(path.join(mermaid, 'LICENSE'), path.join(out, 'vendor/mermaid.LICENSE'))

const version = (dir) => desktop(path.join(dir, 'package.json')).version
console.log(
  `katex ${version(katex)} (${fonts.length} fonts), mermaid ${version(mermaid)} -> ${out}`
)
