#!/usr/bin/env node
/**
 * Build the WebView editor into a single self-contained module (T057/T058).
 *
 * The contract requires the editor asset to open with no network, so vite's
 * output is folded into ONE html document and emitted as a TypeScript module —
 * Metro serves modules, not directories of chunks, and a string is the only
 * form `WebView source={{ html }}` accepts on both platforms.
 *
 * The document is stored GZIPPED and base64-encoded rather than as a literal:
 * BlockNote plus its code-block highlighter is ~4.5 MB of JS, and a 4.5 MB
 * string literal is 4.5 MB in every checkout, every diff and every Metro
 * bundle. Deflated it is roughly a fifth of that, and the one-time inflate at
 * editor open runs through pako, which the app already ships. The inflate is
 * off the keystroke path by construction — it happens once, before mount.
 *
 * The generated module also carries a freshness hash over the editor-web
 * sources and the shared bridge contract. That hash is what
 * `check-editor-web.mjs` compares (the `ipc:check` discipline) and what the
 * `ready` handshake reports, so a stale asset fails in CI and at runtime
 * rather than silently speaking an older protocol.
 *
 *   node scripts/build-editor-web.mjs            # build + write
 *   node scripts/build-editor-web.mjs --check    # verify the checked-in asset
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mobileRoot = resolve(here, '..')
const repoRoot = resolve(mobileRoot, '../..')
const editorWebRoot = join(mobileRoot, 'editor-web')
const contractFile = join(repoRoot, 'packages/contracts/src/webview-bridge.ts')
const outFile = join(mobileRoot, 'src/editor/generated/editor-web-asset.ts')

const checkOnly = process.argv.includes('--check')

/** Every input whose change must invalidate the built asset. */
function sourceFiles() {
  const files = [contractFile]
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push(full)
    }
  }
  walk(join(editorWebRoot, 'src'))
  for (const name of ['index.html', 'vite.config.ts', 'package.json']) {
    files.push(join(editorWebRoot, name))
  }
  return files.sort()
}

export function computeFreshnessHash(files) {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(relative(repoRoot, file))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

function readStampedHash() {
  if (!existsSync(outFile)) return null
  const match = /EDITOR_WEB_CONTRACT_HASH = '([0-9a-f]+)'/.exec(readFileSync(outFile, 'utf8'))
  return match?.[1] ?? null
}

const expected = computeFreshnessHash(sourceFiles())

if (checkOnly) {
  const actual = readStampedHash()
  if (actual === expected) {
    console.log(`editor-web asset is current (${expected})`)
    process.exit(0)
  }
  console.error(
    `editor-web asset is STALE.\n` +
      `  expected ${expected}\n` +
      `  found    ${actual ?? '<no generated asset>'}\n` +
      `Run: pnpm --filter @memry/mobile editor:build`
  )
  process.exit(1)
}

const distDir = join(editorWebRoot, 'dist')
rmSync(distDir, { recursive: true, force: true })
execFileSync('pnpm', ['exec', 'vite', 'build'], {
  cwd: editorWebRoot,
  stdio: 'inherit',
  env: { ...process.env, EDITOR_WEB_CONTRACT_HASH: expected }
})

const html = readFileSync(join(distDir, 'index.html'), 'utf8')
const js = readFileSync(join(distDir, 'editor.js'), 'utf8')
const cssPath = join(distDir, 'editor.css')
const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : ''

// vite emits <script type=module src=…> and <link rel=stylesheet href=…>;
// both become inline elements so the document has zero subresources.
let inlined = html
  .replace(/<script\b[^>]*\bsrc="[^"]*editor\.js"[^>]*><\/script>/, () => {
    return `<script type="module">\n${js}\n</script>`
  })
  .replace(/<link\b[^>]*\bhref="[^"]*editor\.css"[^>]*>/, () => {
    return css ? `<style>\n${css}\n</style>` : ''
  })
  // Vite injects a modulepreload for the entry; with the script inlined it
  // would be a request for a file that does not exist, and the CSP forbids it.
  .replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g, '')

if (inlined.includes('editor.js"') || inlined.includes('editor.css"')) {
  console.error('Inlining failed: the built HTML still references an external asset.')
  process.exit(1)
}

const remaining = readdirSync(distDir).filter(
  (name) => !['index.html', 'editor.js', 'editor.css'].includes(name)
)
if (remaining.length > 0) {
  console.error(
    `Build produced unexpected extra assets (${remaining.join(', ')}); the WebView asset must be self-contained.`
  )
  process.exit(1)
}

const packed = gzipSync(Buffer.from(inlined, 'utf8'), { level: 9 }).toString('base64')

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(
  outFile,
  `/* eslint-disable */
/**
 * GENERATED — do not edit. Source: apps/mobile/editor-web/.
 * Rebuild with \`pnpm --filter @memry/mobile editor:build\`;
 * \`editor:check\` fails when this file is older than its sources.
 */

/** Freshness stamp over editor-web sources + the shared bridge contract. */
export const EDITOR_WEB_CONTRACT_HASH = '${expected}'

/** Uncompressed size of the document, for the dev counters. */
export const EDITOR_WEB_HTML_BYTES = ${Buffer.byteLength(inlined, 'utf8')}

/** gzip(html), base64. Inflate with \`loadEditorWebHtml()\`. */
export const EDITOR_WEB_HTML_GZ_B64 =
  ${JSON.stringify(packed)}
`,
  'utf8'
)

console.log(
  `editor-web asset written (${expected}, ${(inlined.length / 1024).toFixed(0)} KB → ${(packed.length / 1024).toFixed(0)} KB packed) → ${relative(repoRoot, outFile)}`
)
