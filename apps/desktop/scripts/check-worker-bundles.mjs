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

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const outMain = resolve(dirname(fileURLToPath(import.meta.url)), '../out/main')

const WORKER_ENTRIES = [
  'sync-worker.js',
  'image-processing-worker.js',
  'voice-transcription-worker.js'
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

process.exit(failed ? 1 : 0)
