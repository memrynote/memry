#!/usr/bin/env node
// Guards worker_threads entries in out/main against requiring 'electron'.
//
// Workers cannot load the electron module — in a packaged app the require
// throws MODULE_NOT_FOUND and the worker dies at boot (in dev it silently
// "works" because node_modules/electron, the installer package, resolves).
// This shipped as an invisible prod-only sync outage: electron-log bundled
// into a shared chunk hoisted `require('electron')` to chunk top level and
// every worker importing the logger crashed before ready.
//
// Walks each worker entry's chunk require-graph and fails the build if any
// reachable chunk contains a literal require("electron").
//
// Also guards the renderer's Excalidraw font-subset worker against importing the
// renderer entry chunk. Rollup once hoisted shared modules into that entry, the
// module worker evaluated app code, and it died on a top-level `window` read
// (#2530). See scripts/excalidraw-subset-worker-plugin.ts.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const outMain = resolve(dirname(fileURLToPath(import.meta.url)), '../out/main')
const outRenderer = resolve(dirname(fileURLToPath(import.meta.url)), '../out/renderer')

const WORKER_ENTRIES = [
  // Not a worker_thread, but it runs under ELECTRON_RUN_AS_NODE as a fallback
  // (see crdt-preflight.ts), where `electron` does not exist either.
  'crdt-preflight-child.js',
  'sync-worker.js',
  'image-processing-worker.js',
  'voice-transcription-worker.js',
  'embedding-worker.js'
]

const RELATIVE_REQUIRE = /require\(["'](\.[^"']+)["']\)/g
const ELECTRON_REQUIRE = /require\(["']electron["']\)/

function collectGraph(entryPath, seen = new Set()) {
  if (seen.has(entryPath)) return seen
  seen.add(entryPath)
  const source = readFileSync(entryPath, 'utf8')
  for (const match of source.matchAll(RELATIVE_REQUIRE)) {
    const dep = resolve(dirname(entryPath), match[1])
    if (existsSync(dep)) collectGraph(dep, seen)
  }
  return seen
}

let failed = false
for (const entry of WORKER_ENTRIES) {
  const entryPath = resolve(outMain, entry)
  if (!existsSync(entryPath)) {
    console.error(
      `check-worker-bundles: missing worker entry ${entry} — run electron-vite build first`
    )
    failed = true
    continue
  }
  const offenders = [...collectGraph(entryPath)].filter((file) =>
    ELECTRON_REQUIRE.test(readFileSync(file, 'utf8'))
  )
  if (offenders.length > 0) {
    console.error(
      `check-worker-bundles: ${entry} reaches require("electron") — this crashes the worker in packaged builds.\n` +
        offenders.map((f) => `  - ${f.replace(outMain + '/', 'out/main/')}`).join('\n') +
        '\nLikely cause: an electron-dependent package got bundled into a chunk shared with a worker.\n' +
        'Fix: keep the package external (package.json `dependencies`, shipped loose) or out of the worker import graph.'
    )
    failed = true
  } else {
    console.log(`check-worker-bundles: ${entry} OK`)
  }
}

// Static ESM imports only: `import ... from "./x.js"` and `import "./x.js"`.
const RELATIVE_STATIC_IMPORT = /(?:^|[;\n])\s*import\s*(?:[^'"();]*?\sfrom\s*)?["'](\.[^"']+)["']/g
const ENTRY_SCRIPT = /<script[^>]*type="module"[^>]*src="\.\/([^"]+)"/g

function collectEsmGraph(entryPath, seen = new Set()) {
  if (seen.has(entryPath)) return seen
  seen.add(entryPath)
  const source = readFileSync(entryPath, 'utf8')
  for (const match of source.matchAll(RELATIVE_STATIC_IMPORT)) {
    const dep = resolve(dirname(entryPath), match[1])
    if (existsSync(dep)) collectEsmGraph(dep, seen)
  }
  return seen
}

const rendererAssets = resolve(outRenderer, 'assets')
const rendererHtml = resolve(outRenderer, 'index.html')
if (!existsSync(rendererHtml) || !existsSync(rendererAssets)) {
  console.error('check-worker-bundles: missing out/renderer — run electron-vite build first')
  failed = true
} else {
  const entryChunks = new Set(
    [...readFileSync(rendererHtml, 'utf8').matchAll(ENTRY_SCRIPT)].map((match) =>
      resolve(outRenderer, match[1])
    )
  )
  const subsetWorkerChunks = readdirSync(rendererAssets).filter(
    (file) => file.startsWith('subset-worker.chunk') && file.endsWith('.js')
  )
  if (entryChunks.size === 0 || subsetWorkerChunks.length === 0) {
    console.error(
      'check-worker-bundles: could not find the renderer entry chunk or the Excalidraw subset worker in out/renderer'
    )
    failed = true
  }
  for (const chunk of subsetWorkerChunks) {
    const reached = [...collectEsmGraph(resolve(rendererAssets, chunk))].filter((file) =>
      entryChunks.has(file)
    )
    if (reached.length > 0) {
      console.error(
        `check-worker-bundles: renderer ${chunk} imports the renderer entry chunk — the Excalidraw ` +
          'subset worker would evaluate app code and crash on `window` (#2530).\n' +
          'Fix: keep excalidrawSubsetWorker() in the renderer plugins so the worker builds as its own entry.'
      )
      failed = true
    } else {
      console.log(`check-worker-bundles: renderer ${chunk} OK`)
    }
  }
}

process.exit(failed ? 1 : 0)
