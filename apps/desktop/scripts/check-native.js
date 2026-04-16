#!/usr/bin/env node
// Detects NODE_MODULE_VERSION mismatch between built native modules
// (better-sqlite3, keytar) and the current runtime (Node or Electron).
//
// Exit 0: native modules load cleanly under the current runtime.
// Exit 1: at least one module's ABI does not match — prints the fix command.
//
// Relies on the stamp file written by apps/desktop/scripts/ensure-native.sh
// to report which target the modules were last built for.

const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const APP_ROOT = join(__dirname, '..')
const STAMP_FILE = join(APP_ROOT, 'node_modules', '.native-build-target')
const MODULES = ['better-sqlite3', 'keytar']

const stamp = existsSync(STAMP_FILE) ? readFileSync(STAMP_FILE, 'utf8').trim() : 'unknown'
const inElectron = Boolean(process.versions.electron)
const currentRuntime = inElectron ? 'electron' : 'node'

function tryRequire(mod) {
  const res = spawnSync(process.execPath, ['-e', `require('${mod}')`], {
    cwd: APP_ROOT,
    encoding: 'utf8'
  })
  if (res.status === 0) return { ok: true }
  const err = (res.stderr || '').trim()
  const match = err.match(/NODE_MODULE_VERSION\s+(\d+).+?this version of Node\.js requires\s+NODE_MODULE_VERSION\s+(\d+)/s)
  return { ok: false, compiledAbi: match?.[1], expectedAbi: match?.[2], err }
}

const failures = []
for (const mod of MODULES) {
  const result = tryRequire(mod)
  if (!result.ok) failures.push({ mod, ...result })
}

if (failures.length === 0) {
  console.log(`[check:native] OK — modules load under ${currentRuntime} (stamp: ${stamp})`)
  process.exit(0)
}

console.error(`[check:native] NODE_MODULE_VERSION mismatch — ${failures.length} module(s) failed to load under ${currentRuntime}:`)
for (const f of failures) {
  if (f.compiledAbi && f.expectedAbi) {
    console.error(`  - ${f.mod}: compiled for ABI ${f.compiledAbi}, runtime needs ABI ${f.expectedAbi}`)
  } else {
    console.error(`  - ${f.mod}: ${f.err.split('\n')[0]}`)
  }
}

const fix = stamp === 'electron' ? 'pnpm rebuild:node' : 'pnpm rebuild:electron'
const altFix = stamp === 'electron' ? 'pnpm rebuild:electron' : 'pnpm rebuild:node'
console.error('')
console.error(`[check:native] stamp says last build target was "${stamp}"; current runtime is "${currentRuntime}".`)
console.error(`[check:native] fix:`)
console.error(`    ${fix}           # to run tests/scripts under Node`)
console.error(`    ${altFix}        # to run the Electron app (pnpm dev)`)
process.exit(1)
