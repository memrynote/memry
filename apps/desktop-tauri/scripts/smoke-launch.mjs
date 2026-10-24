#!/usr/bin/env node
// Launch smoke for a built memry-tauri binary: starts it with its data and log directories in a
// temp dir, waits for the startup marker and the renderer's first command in main.log, keeps it
// alive a few more seconds, then kills it.
//
// With `--expect-no-driver` the app starts as a test would (`MEMRY_E2E=1`, a WebDriver port) and
// the smoke also fails if the port accepts a connection or the log says a driver started: a
// release binary must carry none.
//
//   node smoke-launch.mjs <binary> [--expect-no-driver]
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const STARTUP_MARKER = /MemryNote 0\.0\.0 starting \((?:dev|packaged)\)/
const RENDERER_MARKER = 'renderer started'
const POLL_MS = 250
const DRIVER_MARKER = /WDIO WebDriver plugin initialized/

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

function accepts(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

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
  {
    timeoutMs = 45_000,
    settleMs = 5_000,
    xvfb = process.platform === 'linux',
    expectNoDriver = false
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'memry-smoke-'))
  const logDir = join(root, 'logs')
  const logFile = join(logDir, 'main.log')
  const env = {
    ...process.env,
    MEMRY_APP_DATA_DIR: join(root, 'data'),
    MEMRY_TEST_LOG_DIR: logDir
  }
  let driverPort = 0
  if (expectNoDriver) {
    driverPort = await freePort()
    env.MEMRY_E2E = '1'
    env.TAURI_WEBDRIVER_PORT = String(driverPort)
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
    const log = readLog(logFile)
    const alive = ready && !state.exited
    if (expectNoDriver && alive) {
      const listening = await accepts(driverPort)
      if (listening || DRIVER_MARKER.test(log)) {
        return { ok: false, log, exited: state.exited, driver: true }
      }
    }
    return { ok: alive, log, exited: state.exited, driver: false }
  } finally {
    child.kill()
    // `xvfb-run` leaves the app behind unless the group goes with it.
    await sleep(200)
    rmSync(root, { recursive: true, force: true })
  }
}

async function main() {
  const [binary, ...flags] = process.argv.slice(2)
  if (!binary) {
    console.error('usage: smoke-launch.mjs <binary> [--expect-no-driver]')
    process.exit(2)
  }
  const expectNoDriver = flags.includes('--expect-no-driver')
  const result = await smokeLaunch(binary, { expectNoDriver })
  if (result.ok) {
    console.log(
      `smoke-launch: startup marker and "renderer started" found, app stayed up${expectNoDriver ? ', no driver' : ''}`
    )
    return
  }
  if (result.driver) console.error('smoke-launch: the binary runs a WebDriver server')
  const tail = result.log.split('\n').slice(-40).join('\n')
  console.error(
    `smoke-launch: failed (${result.exited ? `exited ${JSON.stringify(result.exited)}` : 'timed out'})\n--- main.log tail ---\n${tail}`
  )
  process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
