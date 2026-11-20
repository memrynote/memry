#!/usr/bin/env node
// Fresh-device bootstrap benchmark (#5223). One command per shell, the same
// metrics for each: see apps/docs/src/contribute/testing.md, Bootstrap Benchmark.
//
//   pnpm bench:bootstrap core --vault sandboxmobile [--runs 2]
//   pnpm bench:bootstrap core --login --email <address> --phrase-file <path>
//   pnpm bench:bootstrap electron --vault sandboxmobile

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import { parseKeychainDump } from '../../apps/desktop/scripts/purge-e2e-keychain.mjs'
import { electronMarks, followLog, parseMainLog } from './electron-log.mjs'
import { formatReport, summarize } from './metrics.mjs'
import { startProxy } from './proxy.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT_DIR = path.join(ROOT, '.perf/bootstrap-bench')
const STAGING = 'https://sync-staging.memrynote.com'
const SIGN_IN_DEADLINE_MS = 20 * 60_000
const LOG_POLL_MS = 500

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    vault: { type: 'string' },
    runs: { type: 'string', default: '1' },
    server: { type: 'string', default: STAGING },
    port: { type: 'string', default: '8791' },
    'line-mbps': { type: 'string', default: '50' },
    'timeout-min': { type: 'string', default: '40' },
    'cdp-port': { type: 'string', default: '9334' },
    login: { type: 'boolean', default: false },
    email: { type: 'string' },
    'phrase-file': { type: 'string' }
  }
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fail(message) {
  throw new Error(message)
}

// ---------------------------------------------------------------- core (memry)

const CLI_HOME = process.env.MEMRY_BENCH_HOME ?? path.join(os.homedir(), '.memry-bench')

function buildCli() {
  const built = spawnSync(
    'cargo',
    ['build', '--release', '-p', 'memry-cli', '--manifest-path', 'crates/Cargo.toml'],
    { cwd: ROOT, stdio: 'inherit' }
  )
  if (built.status !== 0) fail('cargo build of memry-cli failed')
  return path.join(ROOT, 'crates/target/release/memry')
}

// Never spawnSync: the proxy runs on this process's event loop.
function cli(binary, proxyUrl, args, stdio = ['inherit', 'pipe', 'pipe']) {
  const child = spawn(binary, ['--server', proxyUrl, ...args], {
    env: { ...process.env, HOME: CLI_HOME },
    stdio
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => (stdout += chunk))
  child.stderr?.on('data', (chunk) => (stderr += chunk))
  return new Promise((resolve) => child.on('exit', (status) => resolve({ status, stdout, stderr })))
}

async function resolveVaultId(binary, proxyUrl, wanted) {
  const listed = await cli(binary, proxyUrl, ['vaults'])
  if (listed.status !== 0) fail(`memry vaults failed: ${listed.stderr.trim()}`)
  for (const line of listed.stdout.split('\n')) {
    const [id, name] = line.split('\t')
    if (id && (id === wanted || name === wanted)) return id
  }
  throw new Error(`no vault named ${wanted} on this account`)
}

async function runCore(proxy) {
  const binary = buildCli()
  if (values.login) {
    if (!values.email || !values['phrase-file']) fail('--login needs --email and --phrase-file')
    for (const args of [
      ['login', '--email', values.email],
      ['unlock', '--recovery-phrase-file', values['phrase-file']]
    ]) {
      if ((await cli(binary, proxy.url, args, 'inherit')).status !== 0) fail(`${args[0]} failed`)
    }
    return null
  }
  const vaultId = await resolveVaultId(binary, proxy.url, values.vault)
  proxy.requests.length = 0

  const marks = {}
  const shell = { bodyPasses: 0 }
  const child = spawn(binary, ['--server', proxy.url, 'bench', 'bootstrap', '--vault', vaultId], {
    env: { ...process.env, HOME: CLI_HOME },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const event = JSON.parse(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      if (event.mark === 'start') marks.startMs = event.atMs
      if (event.mark === 'records') marks.recordsMs = event.atMs
      if (event.mark === 'bodies') marks.bodiesMs = event.atMs
      if (event.mark === 'bodyPass') shell.bodyPasses += 1
      if (['firstSync', 'end', 'bodiesNotReached'].includes(event.mark)) shell[event.mark] = event
    }
  })
  const code = await new Promise((resolve) => child.on('exit', resolve))
  if (code !== 0) fail(`memry bench bootstrap exited ${code}`)
  return { marks, shell, staleLockReleases: 0 }
}

// ------------------------------------------------------------- electron (dev)

function purgeBenchKeychain(deviceId) {
  if (process.platform !== 'darwin') return
  const dump = spawnSync('security', ['dump-keychain'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
  for (const { service, account } of parseKeychainDump(dump.stdout ?? '')) {
    const ours =
      (service === 'com.memry.sync' && account?.endsWith(`-${deviceId}`)) ||
      service === `memry-${deviceId} Safe Storage`
    if (ours) {
      spawnSync('security', ['delete-generic-password', '-s', service, '-a', account], {
        stdio: 'ignore',
        timeout: 10_000
      })
    }
  }
}

async function runElectron(proxy) {
  const deviceId = `e2e-bench-${randomUUID()}`
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-bench-userdata-'))
  const logDir = path.join(userDataDir, 'logs')
  const logPath = path.join(logDir, 'main.log')
  const env = {
    ...process.env,
    MEMRY_ENV: 'staging',
    MEMRY_DEVICE: deviceId,
    MEMRY_TEST_LOG_DIR: logDir,
    SYNC_SERVER_URL: proxy.url
  }
  delete env.ELECTRON_RUN_AS_NODE
  fs.mkdirSync(logDir, { recursive: true })
  const devLog = fs.openSync(path.join(logDir, 'dev.log'), 'a')
  const child = spawn(
    process.execPath,
    [
      'scripts/dev.mjs',
      '--mode=staging',
      '--remoteDebuggingPort',
      values['cdp-port'],
      '--',
      `--user-data-dir=${userDataDir}`
    ],
    // stdin stays open: electron-vite ends its dev session when stdin closes.
    { cwd: path.join(ROOT, 'apps/desktop'), env, detached: true, stdio: ['pipe', devLog, devLog] }
  )
  console.log(
    `Electron started (device ${deviceId}, CDP ${values['cdp-port']}). Sign in to staging and ` +
      `download "${values.vault}" from the account vault picker. Timing starts at the download.`
  )

  let parsed = null
  const readLog = followLog(logPath, fs)
  // Ctrl+C ends the wait and still runs the cleanup below.
  let interrupted = false
  const interrupt = () => (interrupted = true)
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const signInDeadline = Date.now() + SIGN_IN_DEADLINE_MS
    let runDeadline = null
    for (;;) {
      await sleep(LOG_POLL_MS)
      parsed = electronMarks(parseMainLog(readLog().join('\n')))
      if (parsed?.marks.bodiesMs || interrupted) break
      if (parsed && runDeadline === null) {
        runDeadline = Date.now() + Number(values['timeout-min']) * 60_000
        console.log('Bootstrap window opened; measuring.')
      }
      if (runDeadline === null && Date.now() > signInDeadline) fail('no vault download started')
      if (runDeadline !== null && Date.now() > runDeadline) break
    }
  } finally {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM')
    } catch {
      // already gone
    }
    await sleep(3_000)
    const kept = path.join(OUT_DIR, `electron-main-${deviceId}.log`)
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(kept, `${readLog().join('\n')}\n`)
    for (const dir of [userDataDir, `${userDataDir}-${deviceId}`]) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
    purgeBenchKeychain(deviceId)
    console.log(`main.log lines the benchmark read: ${kept}`)
    console.log(
      `Remove the downloaded vault folder (default ~/Documents/Memry/) and the staging device ` +
        `${deviceId} from another device's settings.`
    )
  }
  if (!parsed) throw new Error('main.log never opened a bootstrap window')
  return parsed
}

// ---------------------------------------------------------------------- main

async function main() {
  const shellName = positionals[0]
  if (!['core', 'electron'].includes(shellName))
    fail('usage: bench.mjs <core|electron> --vault <name>')
  if (!values.login && !values.vault) fail('--vault <name or id> is required')
  if (/sync\.memrynote\.com/.test(values.server)) fail('production is out of bounds')

  const runs = values.login ? 1 : Number(values.runs)
  for (let run = 1; run <= runs; run++) {
    const proxy = await startProxy({ upstream: values.server, port: Number(values.port) })
    let result
    try {
      result = shellName === 'core' ? await runCore(proxy) : await runElectron(proxy)
    } finally {
      await proxy.close()
    }
    if (!result) return
    const metrics = summarize({
      requests: proxy.requests,
      marks: result.marks,
      staleLockReleases: result.staleLockReleases,
      lineMbps: Number(values['line-mbps'])
    })
    const label = `${shellName} · ${values.vault} · run ${run}/${runs}`
    const record = {
      shell: shellName,
      vault: values.vault,
      run,
      at: new Date().toISOString(),
      metrics,
      detail: result.shell
    }
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const file = path.join(OUT_DIR, `${shellName}-${record.at.replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
    console.log(formatReport(label, metrics))
    console.log(`shell detail: ${JSON.stringify(result.shell)}`)
    console.log(`saved ${path.relative(ROOT, file)}`)
  }
}

try {
  await main()
} catch (error) {
  console.error(`bench:bootstrap: ${error.message}`)
  process.exitCode = 2
}
