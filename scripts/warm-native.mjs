#!/usr/bin/env node
/**
 * Warm the desktop app's native build so the first `pnpm dev` in a fresh
 * worktree does not pay the electron-rebuild tax.
 *
 * Background: `apps/desktop` postinstall used to run `electron-rebuild` directly.
 * That rebuild never wrote `node_modules/.native-build-target`, the stamp file
 * `ensure-native.sh` keys off, so `predev` rebuilt better-sqlite3, keytar and
 * both classic-level copies all over again -- a minute-plus wait on the first
 * `pnpm dev` after `git worktree add` + `pnpm install`.
 *
 * Now postinstall calls this script with `--background`: it detaches, runs
 * `ensure-native.sh <target>` (which writes the stamp), and lets `pnpm install`
 * return immediately. `ensure-native.sh` takes a lock, so a `pnpm dev` started
 * while the warm-up is still running waits for it instead of racing it into a
 * second rebuild.
 *
 * Usage:
 *   node scripts/warm-native.mjs                 # foreground, electron target
 *   node scripts/warm-native.mjs --background    # detach, log to the file below
 *   node scripts/warm-native.mjs --target node   # node target instead
 *   node scripts/warm-native.mjs --log           # print the warm-up log path
 *
 * Log: apps/desktop/node_modules/.native-warm.log
 */

import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_ROOT = path.join(REPO_ROOT, 'apps', 'desktop')
const ENSURE_NATIVE = path.join(APP_ROOT, 'scripts', 'ensure-native.sh')
const LOG_FILE = path.join(APP_ROOT, 'node_modules', '.native-warm.log')

const argv = process.argv.slice(2)
const background = argv.includes('--background')
const targetIndex = argv.indexOf('--target')
const target = targetIndex === -1 ? 'electron' : (argv[targetIndex + 1] ?? 'electron')

if (argv.includes('--log')) {
  process.stdout.write(`${LOG_FILE}\n`)
  if (existsSync(LOG_FILE)) process.stdout.write(readFileSync(LOG_FILE, 'utf8'))
  process.exit(0)
}

// The opt-out lives here, not in the postinstall script line: that line runs
// through pnpm's shell, and a `[ "$SKIP_ELECTRON_REBUILD" = '1' ] ||` guard is
// POSIX-only — on Windows it never short-circuits, so CI's skip was ignored and
// the Electron rebuild ran anyway (and failed resolving @electron/rebuild).
if (process.env.SKIP_ELECTRON_REBUILD === '1') {
  console.log('[warm-native] SKIP_ELECTRON_REBUILD=1 — skipping the native warm-up')
  process.exit(0)
}

if (target !== 'electron' && target !== 'node') {
  console.error(`[warm-native] unknown target "${target}" (expected electron or node)`)
  process.exit(1)
}

// CI pins its own rebuild steps and needs a deterministic, blocking install.
const detach = background && !process.env.CI

if (detach) {
  mkdirSync(path.dirname(LOG_FILE), { recursive: true })
  const log = openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--target', target], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', log, log]
  })
  child.unref()
  console.log(
    `[warm-native] warming ${target} native modules in the background (pid ${child.pid}); log: ${path.relative(REPO_ROOT, LOG_FILE)}`
  )
  process.exit(0)
}

const child = spawn('bash', [ENSURE_NATIVE, target], { cwd: APP_ROOT, stdio: 'inherit' })
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
