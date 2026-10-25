#!/usr/bin/env node
// Starts the e2e build of the Tauri app in a throwaway sandbox so an agent can drive it over
// WebDriver, the counterpart of `apps/desktop/scripts/agent-app.mjs` for Electron.
//
//   pnpm --filter @memry/desktop-tauri build:e2e     # once per code change
//   node apps/desktop-tauri/scripts/agent-app.mjs start
//   node apps/desktop-tauri/scripts/agent-app.mjs eval "document.title"
//   node apps/desktop-tauri/scripts/agent-app.mjs shot /tmp/agent.png
//   node apps/desktop-tauri/scripts/agent-app.mjs status
//   node apps/desktop-tauri/scripts/agent-app.mjs stop
//
// Isolation is the e2e harness's: a mkdtemp app data dir, a copy of the test vault and an
// `e2e-agent-<uuid>` device, handed to the app through the control file of its WebDriver port
// (`memry_desktop::e2e::control`). The real profile and vaults are never opened, and `stop`
// removes the dirs and the device's keychain items.
//
// Options for `start`: MEMRY_AGENT_VAULT_TEMPLATE=<vault dir> opens a copy of that vault,
// MEMRY_AGENT_FIRST_RUN=1 opens no vault so the first-run setup shows, MEMRY_AGENT_SCALE=2
// renders at 2x (Windows and Linux), MEMRY_AGENT_BINARY=<path> replaces the debug build, and
// TAURI_WEBDRIVER_PORT=<port> replaces 9222.
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { purgeKeychainForDevice } from '../e2e/harness/keychain-cleanup.mjs'
import { evaluateInPage, INVOKE_SCRIPT } from './lib/page-scripts.mjs'
import { createClient } from './lib/webdriver-client.mjs'

const APP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_PORT = 9222
const READY_TIMEOUT_MS = 60_000
const QUIT_TIMEOUT_MS = 8_000
const BUILD_HINT = 'Build it first: pnpm --filter @memry/desktop-tauri build:e2e'

const sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms))

export function defaultBinary() {
  const name = process.platform === 'win32' ? 'memry-tauri.exe' : 'memry-tauri'
  return resolve(APP_DIR, '../../crates/target/debug', name)
}

/**
 * @typedef {object} Context
 * @property {NodeJS.ProcessEnv} env
 * @property {string} tmp the temp dir every sandbox path lives under
 * @property {(deviceId: string) => void} purgeKeychain
 * @property {(line: string) => void} out
 * @property {(line: string) => void} err
 */

/** @returns {Context} */
export function defaultContext() {
  return {
    env: process.env,
    tmp: tmpdir(),
    purgeKeychain: (deviceId) => purgeKeychainForDevice(deviceId),
    out: (line) => console.log(line),
    err: (line) => console.error(line)
  }
}

const stateFile = (/** @type {Context} */ ctx) => join(ctx.tmp, 'memry-agent-app-tauri.json')
const controlFile = (/** @type {Context} */ ctx, /** @type {number} */ port) =>
  join(ctx.tmp, 'memry-e2e', `control-${port}.json`)
const portOf = (/** @type {Context} */ ctx) => Number(ctx.env.TAURI_WEBDRIVER_PORT ?? DEFAULT_PORT)

function readState(/** @type {Context} */ ctx) {
  try {
    return JSON.parse(readFileSync(stateFile(ctx), 'utf8'))
  } catch {
    return null
  }
}

/** The Node error code of a failed system call, or an empty string. */
function errnoCode(/** @type {unknown} */ error) {
  return error instanceof Error && 'code' in error ? String(error.code) : ''
}

function isAlive(/** @type {number} */ pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errnoCode(error) === 'EPERM'
  }
}

function forceKill(/** @type {number} */ pid) {
  if (process.platform === 'win32') {
    // /T ends the WebView2 helpers too; they hold the profile files open.
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

/** Removes a sandbox path, only when it lives under the temp dir; retries while helpers exit. */
async function removeSandboxPath(
  /** @type {Context} */ ctx,
  /** @type {string | undefined} */ path
) {
  if (!path || !resolve(path).startsWith(resolve(ctx.tmp) + sep)) return
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (error) {
      const code = errnoCode(error)
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes(code) || attempt >= 40) throw error
      await sleep(250)
    }
  }
}

async function cleanup(/** @type {Context} */ ctx, /** @type {any} */ state) {
  await removeSandboxPath(ctx, state.appDataDir)
  await removeSandboxPath(ctx, state.vaultRoot)
  rmSync(controlFile(ctx, state.port), { force: true })
  ctx.purgeKeychain(state.deviceId)
  rmSync(stateFile(ctx), { force: true })
}

function childEnv(/** @type {Context} */ ctx, /** @type {number} */ port) {
  const env = { ...ctx.env, MEMRY_E2E: '1', TAURI_WEBDRIVER_PORT: String(port) }
  const scale = ctx.env.MEMRY_AGENT_SCALE
  if (scale) {
    if (process.platform === 'win32') {
      env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--force-device-scale-factor=${scale}`
    } else if (process.platform === 'linux') {
      env.GDK_SCALE = scale
    } else {
      ctx.out('MEMRY_AGENT_SCALE ignored: macOS renders at the display scale.')
    }
  }
  return env
}

/** Polls `/status` until the driver reports ready; throws when the app exits first. */
async function waitForDriver(client, /** @type {{ exited: string | undefined }} */ watch) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (watch.exited) throw new Error(`The app exited during startup (${watch.exited}).`)
    try {
      if ((await client.status()).ready === true) return
    } catch {
      // not listening yet
    }
    await sleep(250)
  }
  throw new Error(`No WebDriver on ${client.baseUrl} after ${READY_TIMEOUT_MS / 1000} s.`)
}

/** Calls an `e2e_*` command through the page. */
async function invoke(client, sessionId, name, args = {}) {
  const outcome = await client.executeAsync(sessionId, INVOKE_SCRIPT, [name, args])
  if (!outcome?.ok) throw new Error(`${name} failed: ${JSON.stringify(outcome?.error)}`)
  return outcome.value
}

/** `e2e_app_info` is answered once the page has loaded; poll, then name the likely cause. */
async function waitForAppInfo(client, sessionId, deadline) {
  let last
  while (Date.now() < deadline) {
    try {
      return await invoke(client, sessionId, 'e2e_app_info')
    } catch (error) {
      last = error
      await sleep(250)
    }
  }
  throw new Error(`The app did not answer e2e_app_info (${String(last)}). ${BUILD_HINT}`)
}

export async function start(/** @type {Context} */ ctx) {
  const existing = readState(ctx)
  if (existing && isAlive(existing.pid)) {
    ctx.out(`Already running (pid ${existing.pid}). Use "stop" first.`)
    return 0
  }
  if (existing) await cleanup(ctx, existing)

  const binary = ctx.env.MEMRY_AGENT_BINARY ?? defaultBinary()
  if (!existsSync(binary)) {
    ctx.err(`${binary} missing. ${BUILD_HINT}`)
    return 1
  }

  const port = portOf(ctx)
  const template = ctx.env.MEMRY_AGENT_VAULT_TEMPLATE ?? join(APP_DIR, 'e2e/fixtures/test-vault')
  const firstRun = ctx.env.MEMRY_AGENT_FIRST_RUN === '1'
  const deviceId = `e2e-agent-${randomUUID()}`
  const appDataDir = mkdtempSync(join(ctx.tmp, 'memry-agent-appdata-'))
  const logDir = join(appDataDir, 'logs')
  const vaultRoot = mkdtempSync(join(ctx.tmp, 'memry-agent-vault-'))
  // The sidebar shows the vault folder's name, so the copy keeps the template's.
  const vaultPath = join(vaultRoot, basename(template))
  cpSync(template, vaultPath, { recursive: true })

  mkdirSync(join(ctx.tmp, 'memry-e2e'), { recursive: true })
  writeFileSync(
    controlFile(ctx, port),
    JSON.stringify({
      appDataDir,
      logDir,
      device: deviceId,
      testVaultPath: firstRun ? null : vaultPath,
      syncServerUrl: null,
      extraEnv: {}
    })
  )

  const base = { deviceId, appDataDir, vaultRoot, vaultPath, logDir, port, binary }
  const watch = { exited: /** @type {string | undefined} */ (undefined) }
  const child = spawn(binary, [], {
    env: childEnv(ctx, port),
    detached: true,
    stdio: 'ignore'
  })
  child.once('exit', (code, signal) => {
    watch.exited = `code=${code} signal=${signal}`
  })
  child.once('error', (error) => {
    watch.exited = String(error)
  })
  child.unref()
  const pid = child.pid
  if (pid === undefined) throw new Error(`Could not start ${binary}.`)
  writeFileSync(stateFile(ctx), JSON.stringify({ ...base, pid, sessionId: null }, null, 2))

  const client = createClient(`http://127.0.0.1:${port}`)
  try {
    const deadline = Date.now() + READY_TIMEOUT_MS
    await waitForDriver(client, watch)
    const sessionId = await client.newSession()
    const info = await waitForAppInfo(client, sessionId, deadline)
    if (info.device !== deviceId) {
      throw new Error(
        `Control file not applied: the app runs device ${info.device}, not ${deviceId}.`
      )
    }
    writeFileSync(stateFile(ctx), JSON.stringify({ ...base, pid, sessionId }, null, 2))
  } catch (error) {
    await stop(ctx)
    ctx.err(error instanceof Error ? error.message : String(error))
    return 1
  }

  ctx.out(`Started pid ${pid}`)
  ctx.out(`  WebDriver: ${client.baseUrl}`)
  ctx.out(`  vault:     ${vaultPath}`)
  ctx.out(`  logs:      ${join(logDir, 'main.log')}`)
  return 0
}

export async function stop(/** @type {Context} */ ctx) {
  const state = readState(ctx)
  if (!state) {
    ctx.out('Not running.')
    return 0
  }
  if (isAlive(state.pid)) {
    if (state.sessionId) {
      try {
        await invoke(
          createClient(`http://127.0.0.1:${state.port}`),
          state.sessionId,
          'e2e_request_quit'
        )
      } catch {
        // The app may already be gone; the kill below covers a hung one.
      }
    }
    const deadline = Date.now() + QUIT_TIMEOUT_MS
    while (isAlive(state.pid) && Date.now() < deadline) await sleep(100)
    if (isAlive(state.pid)) forceKill(state.pid)
  }
  await cleanup(ctx, state)
  ctx.out('Stopped and cleaned up.')
  return 0
}

export function status(/** @type {Context} */ ctx) {
  const state = readState(ctx)
  if (!state) ctx.out('Not running.')
  else ctx.out(JSON.stringify({ ...state, alive: isAlive(state.pid) }, null, 2))
  return 0
}

/** The state of a running app, with a session that still works. */
async function liveSession(/** @type {Context} */ ctx) {
  const state = readState(ctx)
  if (!state || !isAlive(state.pid))
    throw new Error('Not running. Start it with: agent-app.mjs start')
  const client = createClient(`http://127.0.0.1:${state.port}`)
  if (state.sessionId) {
    try {
      await client.windowHandles(state.sessionId)
      return { client, sessionId: state.sessionId }
    } catch {
      // the session ended; open another
    }
  }
  const sessionId = await client.newSession()
  writeFileSync(stateFile(ctx), JSON.stringify({ ...state, sessionId }, null, 2))
  return { client, sessionId }
}

export async function evaluate(/** @type {Context} */ ctx, /** @type {string} */ expression) {
  if (!expression) {
    ctx.err('Usage: agent-app.mjs eval "<javascript>"')
    return 1
  }
  const { client, sessionId } = await liveSession(ctx)
  const outcome = await evaluateInPage(client, sessionId, expression)
  if (!outcome?.ok) {
    ctx.err(String(outcome?.error))
    return 1
  }
  const value = outcome.value
  ctx.out(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  return 0
}

export async function shot(/** @type {Context} */ ctx, /** @type {string} */ file) {
  if (!file) {
    ctx.err('Usage: agent-app.mjs shot <file.png>')
    return 1
  }
  const { client, sessionId } = await liveSession(ctx)
  writeFileSync(file, await client.screenshot(sessionId))
  ctx.out(resolve(file))
  return 0
}

/**
 * @param {string[]} argv
 * @param {Context} ctx
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, ctx) {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'start':
        return await start(ctx)
      case 'stop':
        return await stop(ctx)
      case 'status':
        return status(ctx)
      case 'eval':
        return await evaluate(ctx, rest.join(' '))
      case 'shot':
        return await shot(ctx, rest[0] ?? '')
      default:
        ctx.err('Usage: agent-app.mjs <start|stop|status|eval "<javascript>"|shot <file.png>>')
        return 1
    }
  } catch (error) {
    ctx.err(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), defaultContext())
}
