#!/usr/bin/env node
/**
 * Launch the built desktop app in a throwaway sandbox so an agent can drive it:
 * the renderer over CDP (official @playwright/mcp with --cdp-endpoint) and the
 * main process over the Node inspector (`eval` below).
 *
 * Isolation mirrors tests/e2e/utils/electron-lifecycle.ts: a copy of the E2E
 * test vault, a mkdtemp userData dir, NODE_ENV=test, and an `e2e-agent-<uuid>`
 * MEMRY_DEVICE so keychain items never touch real dev/prod accounts and are
 * purged on stop. The real profile and vaults are never opened.
 *
 *   pnpm --filter @memry/desktop exec electron-vite build   # once per code change
 *   node scripts/agent-app.mjs start
 *   node scripts/agent-app.mjs eval "process.mainModule.require('electron').app.getVersion()"
 *   node scripts/agent-app.mjs status
 *   node scripts/agent-app.mjs stop
 *
 * Optional env for start: MEMRY_AGENT_VAULT_TEMPLATE=<vault dir> opens a copy of that
 * vault instead (without the portal examples the default vault carries) (tutorial recordings use this), MEMRY_AGENT_FIRST_RUN=1 opens no vault
 * so the first-run setup shows (new vaults default to the sandbox, not ~/Documents),
 * and MEMRY_AGENT_SCALE=2 renders at 2x.
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseKeychainDump } from './purge-e2e-keychain.mjs'
import { PORTAL_EXAMPLES_EXPRESSION } from './agent-vault-portals.mjs'

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN_ENTRY = path.join(DESKTOP_DIR, 'out/main/index.js')
// Override to demo a richer vault (e.g. tutorial recordings). It is copied, never opened in place.
const VAULT_TEMPLATE =
  process.env.MEMRY_AGENT_VAULT_TEMPLATE ?? path.join(DESKTOP_DIR, 'tests/e2e/fixtures/test-vault')
const NATIVE_STAMP = path.join(DESKTOP_DIR, 'node_modules/.native-build-target')
const STATE_FILE = path.join(os.tmpdir(), 'memry-agent-app.json')
const CDP_PORT = Number(process.env.MEMRY_AGENT_CDP_PORT ?? 9222)
const INSPECT_PORT = Number(process.env.MEMRY_AGENT_INSPECT_PORT ?? 9229)
const READY_TIMEOUT_MS = 45_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.json()
}

async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const [targets] = await Promise.all([
        fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`),
        fetchJson(`http://127.0.0.1:${INSPECT_PORT}/json/list`)
      ])
      if (targets.some((t) => t.type === 'page')) return
    } catch {
      // not listening yet
    }
    await sleep(300)
  }
  throw new Error(`App did not expose CDP :${CDP_PORT} and inspector :${INSPECT_PORT} in time`)
}

function purgeKeychain(deviceId) {
  if (process.platform !== 'darwin' || !/^e2e-agent-[A-Za-z0-9-]+$/.test(deviceId)) return
  const dump = spawnSync('security', ['dump-keychain'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
  const safeStorage = `memry-${deviceId} Safe Storage`
  for (const { service, account } of parseKeychainDump(dump.stdout ?? '')) {
    const ours =
      (service === 'com.memry.sync' && account?.endsWith(`-${deviceId}`)) || service === safeStorage
    if (!ours) continue
    spawnSync('security', ['delete-generic-password', '-s', service, '-a', account], {
      stdio: 'ignore',
      timeout: 10_000
    })
  }
}

async function start() {
  const existing = readState()
  if (existing && isAlive(existing.pid)) {
    console.log(`Already running (pid ${existing.pid}). Use "stop" first.`)
    return
  }
  if (existing) cleanup(existing)
  if (!fs.existsSync(MAIN_ENTRY)) {
    throw new Error(
      `${MAIN_ENTRY} missing. Run: pnpm --filter @memry/desktop exec electron-vite build`
    )
  }

  // Same precondition as tests/e2e/global-setup.ts: with a Node-ABI better-sqlite3
  // the test vault silently fails to open and the app sits on the vault picker.
  const abi = fs.existsSync(NATIVE_STAMP) ? fs.readFileSync(NATIVE_STAMP, 'utf8').trim() : ''
  if (abi !== 'electron') {
    throw new Error(
      `Native modules are built for "${abi || 'unknown'}", not electron. Run: pnpm --filter @memry/desktop rebuild:electron`
    )
  }

  const deviceId = `e2e-agent-${randomUUID()}`
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-agent-userdata-'))
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-e2e-agent-'))
  // The sidebar shows the vault folder's name, so the copy keeps the template's.
  const vaultPath = path.join(vaultRoot, path.basename(VAULT_TEMPLATE))
  fs.cpSync(VAULT_TEMPLATE, vaultPath, { recursive: true })
  const logDir = path.join(userDataDir, 'logs')

  const firstRun = process.env.MEMRY_AGENT_FIRST_RUN === '1'
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    ...(firstRun ? {} : { TEST_VAULT_PATH: vaultPath }),
    MEMRY_TEST_LOG_DIR: logDir,
    MEMRY_DEVICE: deviceId
  }
  delete env.ELECTRON_RUN_AS_NODE

  // The `electron` package's main export is the binary path when required from Node.
  const electronPath = createRequire(import.meta.url)('electron')
  const child = spawn(
    electronPath,
    [
      `--inspect=${INSPECT_PORT}`,
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      // Renders at 2x on a 1x display, so recordings stay sharp when zoomed.
      ...(process.env.MEMRY_AGENT_SCALE
        ? [`--force-device-scale-factor=${process.env.MEMRY_AGENT_SCALE}`]
        : []),
      MAIN_ENTRY
    ],
    { env, detached: true, stdio: 'ignore' }
  )
  child.unref()

  const state = { pid: child.pid, deviceId, userDataDir, vaultPath, vaultRoot, logDir }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))

  try {
    await waitForReady()
    // The default sandbox vault also carries a small study vault that shows portals. A portal
    // names its source by note id and the app assigns ids, so the notes are created through the
    // app. E2E tests open the fixture directly and never see them.
    if (!firstRun && !process.env.MEMRY_AGENT_VAULT_TEMPLATE)
      await evaluate(PORTAL_EXAMPLES_EXPRESSION)
    // First run: keep the setup's default notes folder inside the sandbox.
    if (firstRun)
      await evaluate(
        `process.mainModule.require('electron').app.setPath('documents', ${JSON.stringify(vaultRoot)})`
      )
  } catch (err) {
    await stop()
    throw err
  }

  console.log(`Started pid ${child.pid}`)
  console.log(`  CDP (renderer):  http://127.0.0.1:${CDP_PORT}`)
  console.log(`  Inspector (main): 127.0.0.1:${INSPECT_PORT}`)
  console.log(`  vault:   ${vaultPath}`)
  console.log(`  logs:    ${path.join(logDir, 'main.log')}`)
}

function cleanup(state) {
  // MEMRY_DEVICE makes Electron resolve userData to `<--user-data-dir>-<device>`.
  const resolvedUserDataDir = `${state.userDataDir}-${state.deviceId}`
  for (const dir of [state.userDataDir, resolvedUserDataDir, state.vaultRoot ?? state.vaultPath]) {
    // Electron helpers can still be writing to userData after the main pid exits (ENOTEMPTY).
    if (dir?.startsWith(os.tmpdir())) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
  purgeKeychain(state.deviceId)
  fs.rmSync(STATE_FILE, { force: true })
}

async function stop() {
  const state = readState()
  if (!state) {
    console.log('Not running.')
    return
  }
  if (isAlive(state.pid)) {
    process.kill(state.pid, 'SIGTERM')
    for (let i = 0; i < 40 && isAlive(state.pid); i++) await sleep(200)
    if (isAlive(state.pid)) process.kill(state.pid, 'SIGKILL')
  }
  cleanup(state)
  console.log('Stopped and cleaned up.')
}

function status() {
  const state = readState()
  if (!state) return console.log('Not running.')
  console.log(JSON.stringify({ ...state, alive: isAlive(state.pid) }, null, 2))
}

async function evaluate(expression) {
  if (!expression) throw new Error('Usage: agent-app.mjs eval "<expression>"')
  const [target] = await fetchJson(`http://127.0.0.1:${INSPECT_PORT}/json/list`)
  if (!target) throw new Error('No inspector target. Is the app running?')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const response = await new Promise((resolve) => {
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id === 1) resolve(msg)
    })
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
          // Exposes `require` to the expression, like the DevTools console.
          includeCommandLineAPI: true
        }
      })
    )
  })
  ws.close()

  const { result, exceptionDetails } = response.result ?? {}
  if (exceptionDetails) {
    console.error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    process.exitCode = 1
    return
  }
  const value = result?.value !== undefined ? result.value : (result?.description ?? result?.type)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

const [command, ...rest] = process.argv.slice(2)
const commands = { start, stop, status, eval: () => evaluate(rest.join(' ')) }
const run = commands[command]
if (!run) {
  console.error('Usage: agent-app.mjs <start|stop|status|eval "<expression>">')
  process.exit(1)
}
Promise.resolve(run()).catch((/** @type {unknown} */ err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
