// Builds apps/ios/Memry/Resources/Whiteboard.bundle, the page the whiteboard
// editor loads (WhiteboardEditor.swift), from scripts/whiteboard/editor.js.
// Excalidraw, React and the bundler are the copies desktop resolves, so iOS
// draws with the same Excalidraw desktop saves with.
//
//   node apps/ios/scripts/generate-whiteboard.mjs
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const desktopDir = path.join(root, 'apps/desktop')
const desktop = createRequire(path.join(desktopDir, 'package.json'))
const vite = createRequire(desktop.resolve('vite/package.json'))
const esbuild = vite('esbuild')
// The package exports no package.json, so it is found by its folder.
const excalidraw = realpathSync(path.join(desktopDir, 'node_modules/@excalidraw/excalidraw'))

const out = path.join(root, 'apps/ios/Memry/Resources/Whiteboard.bundle')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await esbuild.build({
  entryPoints: [path.join(root, 'apps/ios/scripts/whiteboard/editor.js')],
  // Resolved from desktop, which owns the React and Excalidraw the bundle needs.
  nodePaths: [path.join(desktopDir, 'node_modules')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'safari17',
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"production"}'
  },
  conditions: ['production'],
  // The CSS names its fonts as `./fonts/...`, which is where they are copied.
  external: ['*.woff2'],
  outdir: out,
  entryNames: 'editor',
  logLevel: 'warning'
})

// Every hand-drawn and UI font but Xiaolai: its 12 MB of CJK glyphs would
// triple the bundle, and CJK text falls back to the system font instead.
mkdirSync(path.join(out, 'fonts'))
for (const family of [
  'Assistant',
  'Cascadia',
  'ComicShanns',
  'Excalifont',
  'Liberation',
  'Lilita',
  'Nunito',
  'Virgil'
]) {
  cpSync(path.join(excalidraw, 'dist/prod/fonts', family), path.join(out, 'fonts', family), {
    recursive: true
  })
}

writeFileSync(
  path.join(out, 'editor.html'),
  `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<link rel="stylesheet" href="editor.css">
<style>html,body,#root{margin:0;height:100%;overscroll-behavior:none}</style>
<script>window.EXCALIDRAW_ASSET_PATH = new URL('./', location.href).href</script>
</head>
<body><div id="root"></div><script src="editor.js"></script></body>
</html>
`
)

const { version } = JSON.parse(readFileSync(path.join(excalidraw, 'package.json'), 'utf8'))
console.log(`excalidraw ${version} -> ${out}`)
