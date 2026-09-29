#!/usr/bin/env node
// Guards the main process startup set: the modules out/main/index.js loads
// before any code runs.
//
// The main build puts each npm package in its own chunk (manualChunks in
// electron.vite.config.ts), but a chunk reached by a top-level require is
// still parsed, compiled and executed at launch. The packages listed in
// FORBIDDEN are heavy and only needed on demand (note conversion, AI inline),
// and each stayed resident for the whole session because of one stray static
// import. They must be reached through `await import()` only, which rollup
// emits as `Promise.resolve().then(() => require(...))` and this walk skips.
//
// Needs a build: run `electron-vite build` first. Pass a different main output
// dir as the first argument to check a build written elsewhere.
//   node scripts/check-main-startup-set.mjs [out/main]

import { readFileSync, existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const outMain = resolve(
  process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../out/main')
)
const entryPath = resolve(outMain, 'index.js')

// A package matches when its name equals an entry, or starts with an entry
// ending in '/' (a whole npm scope).
const FORBIDDEN = ['jsdom', 'ai', '@ai-sdk/', '@blocknote/']

// Rollup writes a module's static imports as column-0 `const x = require(...)`
// (or a bare `require(...)` for side-effect imports). Dynamic imports are
// wrapped in `Promise.resolve().then(() => require(...))` and never start a line.
const TOP_LEVEL_REQUIRE = /^(?:(?:const|let|var) [\w$]+ = )?require\((["'])([^"']+)\1\)/gm

// dep-<pkg with the scope slash replaced by '_'>-<8-char hash>.js
function packageOfChunk(file) {
  const match = basename(file).match(/^dep-(.+)-[\w-]{8}\.js$/)
  if (!match) return null
  const name = match[1]
  return name.startsWith('@') ? name.replace('_', '/') : name
}

function isForbidden(pkg) {
  return FORBIDDEN.some((entry) => (entry.endsWith('/') ? pkg.startsWith(entry) : pkg === entry))
}

if (!existsSync(entryPath)) {
  console.error(`check-main-startup-set: missing ${entryPath} — run electron-vite build first`)
  process.exit(1)
}

// file -> the file that first required it, to print the chain for a failure.
const parentOf = new Map([[entryPath, null]])
const externals = new Map()
const pending = [entryPath]
while (pending.length > 0) {
  const file = pending.pop()
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(TOP_LEVEL_REQUIRE)) {
    const specifier = match[2]
    if (!specifier.startsWith('.')) {
      if (!externals.has(specifier)) externals.set(specifier, file)
      continue
    }
    const dep = resolve(dirname(file), specifier)
    if (!existsSync(dep) || parentOf.has(dep)) continue
    parentOf.set(dep, file)
    pending.push(dep)
  }
}

const rel = (file) => file.replace(outMain + '/', '')
const chainOf = (file) => {
  const chain = []
  for (let at = file; at; at = parentOf.get(at)) chain.unshift(rel(at))
  return chain.join(' -> ')
}

const offenders = []
for (const file of parentOf.keys()) {
  const pkg = packageOfChunk(file)
  if (pkg && isForbidden(pkg)) offenders.push(`  - ${pkg}: ${chainOf(file)}`)
}
for (const [specifier, from] of externals) {
  const pkg = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
  if (isForbidden(pkg)) offenders.push(`  - ${specifier} (external): ${chainOf(from)}`)
}

if (offenders.length > 0) {
  console.error(
    'check-main-startup-set: out/main/index.js loads on-demand packages at startup.\n' +
      offenders.sort().join('\n') +
      '\nFix: reach the module that imports them through `await import()` of a bundled ' +
      'module (see ipc/ai-inline-handlers.ts, sync/blocknote-converter-loader.ts, ' +
      'import/_shared/lazy-jsdom.ts).'
  )
  process.exit(1)
}
console.log(
  `check-main-startup-set: OK (${parentOf.size} startup chunks, none of ${FORBIDDEN.join(', ')})`
)
