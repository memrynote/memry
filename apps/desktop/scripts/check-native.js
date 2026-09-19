#!/usr/bin/env node
// Detects a mismatch between the built native modules and the current runtime
// (Node or Electron).
//
// Exit 0: native modules work under the current runtime.
// Exit 1: at least one module failed — prints the fix command.
//
// Relies on the stamp file written by apps/desktop/scripts/ensure-native.sh
// to report which target the modules were last built for.

const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const APP_ROOT = join(__dirname, '..')
const STAMP_FILE = join(APP_ROOT, 'node_modules', '.native-build-target')

// The CRDT store's binding cannot be checked by require() alone. better-sqlite3
// and keytar are NODE_MODULE_VERSION addons: a wrong-runtime build throws on
// load. classic-level is N-API, so a wrong-runtime build loads cleanly and only
// dies later — on open, or on the first write (#1988, win32). Round-trip a
// throwaway doc instead, and go through y-leveldb: the CRDT store loads
// classic-level via `level`, a different resolution than a bare
// require('classic-level'), and that other copy was the one left unrebuilt.
const CRDT_ROUND_TRIP = `
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Y = require('yjs')
const { LeveldbPersistence } = require('y-leveldb')

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-check-native-'))
const PROBE_DOC = '__memry_check_native__'

// A broken binding can hang its callbacks instead of throwing, which would
// leave an empty event loop and a silent exit(0). Keep the timer referenced so
// the hang becomes a failure.
const timer = setTimeout(() => {
  console.error('y-leveldb round trip timed out — the classic-level binding hangs')
  process.exit(1)
}, 30000)

const cleanup = () => fs.rmSync(storeDir, { force: true, recursive: true })

;(async () => {
  const persistence = new LeveldbPersistence(storeDir)
  const doc = new Y.Doc()
  doc.getMap('probe').set('ok', true)
  await persistence.storeUpdate(PROBE_DOC, Y.encodeStateAsUpdate(doc))
  doc.destroy()

  // y-leveldb runs every call inside _transact, which catches, console.warns
  // and resolves null — so a store that failed to open returns null here
  // rather than rejecting.
  const loaded = await persistence.getYDoc(PROBE_DOC)
  if (!loaded) throw new Error('y-leveldb read returned null — see the warning above')
  const value = loaded.getMap('probe').get('ok')
  loaded.destroy()
  if (value !== true) throw new Error('y-leveldb read mismatch: ' + value)

  await persistence.clearDocument(PROBE_DOC)
  await persistence.destroy()
  clearTimeout(timer)
})().then(cleanup, (err) => {
  clearTimeout(timer)
  cleanup()
  console.error(err)
  process.exit(1)
})
`

const PROBES = [
  { mod: 'better-sqlite3', script: "require('better-sqlite3')" },
  { mod: 'keytar', script: "require('keytar')" },
  { mod: 'y-leveldb -> classic-level', script: CRDT_ROUND_TRIP }
]

const stamp = existsSync(STAMP_FILE) ? readFileSync(STAMP_FILE, 'utf8').trim() : 'unknown'
const inElectron = Boolean(process.versions.electron)
const currentRuntime = inElectron ? 'electron' : 'node'

function runProbe(script) {
  const res = spawnSync(process.execPath, ['-e', script], {
    cwd: APP_ROOT,
    encoding: 'utf8'
  })
  if (res.status === 0) return { ok: true }
  const err = [res.stderr, res.stdout].filter(Boolean).join('\n').trim()
  const match = err.match(
    /NODE_MODULE_VERSION\s+(\d+).+?this version of Node\.js requires\s+NODE_MODULE_VERSION\s+(\d+)/s
  )
  return { ok: false, compiledAbi: match?.[1], expectedAbi: match?.[2], err }
}

const failures = []
for (const { mod, script } of PROBES) {
  const result = runProbe(script)
  if (!result.ok) failures.push({ mod, ...result })
}

if (failures.length === 0) {
  console.log(`[check:native] OK — modules work under ${currentRuntime} (stamp: ${stamp})`)
  process.exit(0)
}

console.error(
  `[check:native] ${failures.length} native module check(s) failed under ${currentRuntime}:`
)
for (const f of failures) {
  if (f.compiledAbi && f.expectedAbi) {
    console.error(
      `  - ${f.mod}: compiled for ABI ${f.compiledAbi}, runtime needs ABI ${f.expectedAbi}`
    )
  } else {
    console.error(`  - ${f.mod}: ${f.err.split('\n').slice(0, 3).join('\n      ')}`)
  }
}

const fix = stamp === 'electron' ? 'pnpm rebuild:node' : 'pnpm rebuild:electron'
const altFix = stamp === 'electron' ? 'pnpm rebuild:electron' : 'pnpm rebuild:node'
console.error('')
console.error(
  `[check:native] stamp says last build target was "${stamp}"; current runtime is "${currentRuntime}".`
)
console.error(`[check:native] fix:`)
console.error(`    ${fix}           # to run tests/scripts under Node`)
console.error(`    ${altFix}        # to run the Electron app (pnpm dev)`)
process.exit(1)
