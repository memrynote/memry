#!/usr/bin/env node
// Launch smoke for a built memry-tauri binary: starts it with its data and log directories in a
// temp dir, waits for the startup marker and the renderer's first command in main.log, keeps it
// alive a few more seconds, then kills it.
//
//   node smoke-launch.mjs <binary>
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const STARTUP_MARKER = /MemryNote 0\.0\.0 starting \((?:dev|packaged)\)/
const RENDERER_MARKER = 'renderer started'
const POLL_MS = 250

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readLog(logFile) {
  try {
    return readFileSync(logFile, 'utf8')
  } catch {
    return ''
  }
}

function launch(binary, env, xvfb) {
  if (xvfb) {
    // A runner has no display; xvfb-run provides one.
    return spawn('xvfb-run', ['-a', binary], { env, stdio: 'inherit' })
  }
  return spawn(binary, [], { env, stdio: 'inherit' })
}

/** Resolves `{ ok, log }`. `log` is the whole main.log at the end. */
export async function smokeLaunch(
  binary,
  { timeoutMs = 45_000, settleMs = 5_000, xvfb = process.platform === 'linux' } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'memry-smoke-'))
  const logDir = join(root, 'logs')
  const logFile = join(logDir, 'main.log')
  const env = {
    ...process.env,
    MEMRY_APP_DATA_DIR: join(root, 'data'),
    MEMRY_TEST_LOG_DIR: logDir
  }
  const child = launch(binary, env, xvfb)
  const state = { exited: null }
  child.on('exit', (code, signal) => {
    state.exited = { code, signal }
  })
  child.on('error', (error) => {
    state.exited = { code: null, signal: String(error) }
  })

  try {
    const deadline = Date.now() + timeoutMs
    let ready = false
    while (Date.now() < deadline && !state.exited) {
      const log = readLog(logFile)
      if (STARTUP_MARKER.test(log) && log.includes(RENDERER_MARKER)) {
        ready = true
        break
      }
      await sleep(POLL_MS)
    }
    if (ready) await sleep(settleMs)
    const alive = ready && !state.exited
    return { ok: alive, log: readLog(logFile), exited: state.exited }
  } finally {
    child.kill()
    // `xvfb-run` leaves the app behind unless the group goes with it.
    await sleep(200)
    rmSync(root, { recursive: true, force: true })
  }
}

async function main() {
  const binary = process.argv[2]
  if (!binary) {
    console.error('usage: smoke-launch.mjs <binary>')
    process.exit(2)
  }
  const result = await smokeLaunch(binary)
  if (result.ok) {
    console.log('smoke-launch: startup marker and "renderer started" found, app stayed up')
    return
  }
  const tail = result.log.split('\n').slice(-40).join('\n')
  console.error(
    `smoke-launch: failed (${result.exited ? `exited ${JSON.stringify(result.exited)}` : 'timed out'})\n--- main.log tail ---\n${tail}`
  )
  process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
