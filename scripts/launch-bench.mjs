#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCK_DIR = '/tmp/memry-launch-bench.lock'
const LOG_PATH = path.join(homedir(), 'Library/Logs/memrynote/main.log')
const PERF_DIR = fileURLToPath(new URL('../.perf/', import.meta.url))
const APP_MTIME_STAMP = path.join(PERF_DIR, 'last-app-mtime')

const DEFAULT_RUNS = 5
const DEFAULT_APP = '/Applications/MemryNote.app'
const DEFAULT_PORT = 9222

const SETTLE_MS = 2_000
const QUIT_DEADLINE_MS = 20_000
const CDP_DEADLINE_MS = 30_000
const LOG_DEADLINE_MS = 45_000
const FCP_DEADLINE_MS = 30_000
const CDP_POLL_MS = 250
const LOG_POLL_MS = 100

const LOG_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\b/
const STARTING_LINE_PATTERN = /MemryNote (\S+) starting \((packaged|dev)\)/
const TIMELINE_FIELD_PATTERN = /^([A-Za-z][A-Za-z0-9]*): (.+?),?$/

export const TIERS = {
  packaged: { label: 'packaged (tier 3)', wallClockValid: true },
  dev: { label: 'dev build', wallClockValid: false },
  unknown: { label: 'unknown', wallClockValid: false }
}

export const METRICS = [
  { key: 'click_to_shown_ms', read: (run) => run.clickToShownMs, tier3Only: true },
  { key: 'app_ready_ms', read: (run) => run.timeline?.appReadyMs, tier3Only: false },
  { key: 'window_created_ms', read: (run) => run.timeline?.windowCreatedMs, tier3Only: false },
  { key: 'vault_open_start_ms', read: (run) => run.timeline?.vaultOpenStartMs, tier3Only: false },
  { key: 'vault_open_ready_ms', read: (run) => run.timeline?.vaultOpenReadyMs, tier3Only: false },
  { key: 'renderer_loaded_ms', read: (run) => run.timeline?.rendererLoadedMs, tier3Only: false },
  { key: 'ready_to_show_ms', read: (run) => run.timeline?.readyToShowMs, tier3Only: false },
  { key: 'shown_ms', read: (run) => run.timeline?.shownMs, tier3Only: false },
  { key: 'renderer_first_paint_ms', read: (run) => run.renderer?.firstPaintMs, tier3Only: false },
  { key: 'renderer_fcp_ms', read: (run) => run.renderer?.fcpMs, tier3Only: false },
  {
    key: 'renderer_dom_interactive_ms',
    read: (run) => run.renderer?.domInteractiveMs,
    tier3Only: false
  },
  {
    key: 'renderer_dom_content_loaded_ms',
    read: (run) => run.renderer?.domContentLoadedMs,
    tier3Only: false
  },
  { key: 'cdp_attach_offset_ms', read: (run) => run.cdpAttachOffsetMs, tier3Only: false }
]

const REFUSAL_NOTE = 'refused: not tier 3 (packaged)'
const REFUSAL_CELL = 'refused (not tier 3)'

export function parseLogTimestamp(line) {
  const match = LOG_TIMESTAMP_PATTERN.exec(line)
  if (!match) {
    return null
  }

  const [, year, month, day, hour, minute, second, millisecond] = match

  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond)
  ).getTime()
}

function parseTimelineValue(raw) {
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1)
  }
  if (raw === 'true') {
    return true
  }
  if (raw === 'false') {
    return false
  }

  const numeric = Number(raw)
  return Number.isNaN(numeric) ? raw : numeric
}

export function parseLaunchTimeline(slice) {
  const lines = slice.split('\n')
  let startIndex = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes('launch timeline {')) {
      startIndex = index
    }
  }

  if (startIndex === -1) {
    return null
  }

  const fields = {}
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '}') {
      return fields
    }

    const match = TIMELINE_FIELD_PATTERN.exec(line)
    if (match) {
      fields[match[1]] = parseTimelineValue(match[2])
    }
  }

  return null
}

export function findWindowShownAt(slice) {
  const lines = slice.split('\n').filter((line) => line.includes('main window shown'))
  if (lines.length === 0) {
    return null
  }

  return parseLogTimestamp(lines.at(-1))
}

export function detectTier(slice) {
  return STARTING_LINE_PATTERN.exec(slice)?.[2] ?? 'unknown'
}

export function median(numbers) {
  const sorted = numbers.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) {
    return null
  }

  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[middle]
  }

  return (sorted[middle - 1] + sorted[middle]) / 2
}

export function summarize(runs) {
  const wallClockValid =
    runs.length > 0 && runs.every((run) => TIERS[run.tier]?.wallClockValid === true)

  return METRICS.map(({ key, read, tier3Only }) => {
    if (tier3Only && !wallClockValid) {
      return { key, median: null, unit: 'ms', note: REFUSAL_NOTE }
    }

    return { key, median: median(runs.map(read)), unit: 'ms', note: null }
  })
}

export function formatMedianTable(summary, runs) {
  const width = Math.max(...summary.map((row) => row.key.length), 'metric'.length)
  const tiers = runs.map((run) => `#${run.run} ${run.tier}`).join(', ')
  const lines = [
    `runs: ${runs.length}${tiers ? ` (${tiers})` : ''}`,
    '',
    `${'metric'.padEnd(width)}  median`
  ]

  for (const row of summary) {
    const cell = row.note
      ? REFUSAL_CELL
      : row.median === null
        ? '-'
        : `${Number(row.median.toFixed(3))} ${row.unit}`
    lines.push(`${row.key.padEnd(width)}  ${cell}`)
  }

  return lines.join('\n')
}

function detectAppVersion(slice) {
  return STARTING_LINE_PATTERN.exec(slice)?.[1] ?? null
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function readPositiveInteger(raw, flag) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} requires a positive integer, got: ${raw}`)
  }
  return value
}

function parseArgs(argv) {
  const options = { runs: DEFAULT_RUNS, appPath: DEFAULT_APP, port: DEFAULT_PORT }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--runs') {
      options.runs = readPositiveInteger(readRequiredValue(argv, index, arg), arg)
      index += 1
      continue
    }

    if (arg === '--app') {
      options.appPath = path.resolve(readRequiredValue(argv, index, arg))
      index += 1
      continue
    }

    if (arg === '--port') {
      options.port = readPositiveInteger(readRequiredValue(argv, index, arg), arg)
      index += 1
      continue
    }

    throw new Error(
      `Unknown argument: ${arg}\nUsage: node scripts/launch-bench.mjs [--runs 5] [--app ${DEFAULT_APP}] [--port ${DEFAULT_PORT}]`
    )
  }

  return options
}

let lockHeld = false

function releaseLock() {
  if (!lockHeld) {
    return
  }
  lockHeld = false
  rmSync(LOCK_DIR, { force: true, recursive: true })
}

function refuseOnHeldLock() {
  let owner
  try {
    owner = readFileSync(path.join(LOCK_DIR, 'owner'), 'utf8').trim()
  } catch {
    owner = '(no owner file)'
  }

  console.error(`launch-bench: ${LOCK_DIR} is held by another run.`)
  console.error(owner)
  console.error(`If that pid is dead, remove the lock: rm -rf ${LOCK_DIR}`)
  process.exit(1)
}

function acquireLock() {
  try {
    mkdirSync(LOCK_DIR)
  } catch (error) {
    if (error.code === 'EEXIST') {
      refuseOnHeldLock()
    }
    throw error
  }

  lockHeld = true
  writeFileSync(
    path.join(LOCK_DIR, 'owner'),
    `pid ${process.pid}\nstarted ${new Date().toISOString()}\n`
  )

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      releaseLock()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The bundle directory can be renamed (two builds kept side by side for an A/B), so
// the executable name comes from Info.plist rather than from the directory name.
function readBundleExecutable(appPath) {
  const plist = readFileSync(path.join(appPath, 'Contents/Info.plist'), 'utf8')
  return /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null
}

function readAppMtimeMs(appPath, executableName) {
  return statSync(path.join(appPath, 'Contents/MacOS', executableName)).mtimeMs
}

function readStoredAppMtimeMs() {
  try {
    const stored = Number(readFileSync(APP_MTIME_STAMP, 'utf8').trim())
    return Number.isFinite(stored) ? stored : null
  } catch {
    return null
  }
}

function isAppRunning(appPath) {
  return spawnSync('pgrep', ['-f', `${appPath}/Contents/MacOS/`]).status === 0
}

async function quitApp(appPath, executableName) {
  spawnSync('osascript', ['-e', `quit app "${executableName}"`])

  const deadline = Date.now() + QUIT_DEADLINE_MS
  while (Date.now() < deadline) {
    if (!isAppRunning(appPath)) {
      return
    }
    await delay(CDP_POLL_MS)
  }

  throw new Error(`${appPath} was still running ${QUIT_DEADLINE_MS} ms after the quit request`)
}

function logSizeOrZero() {
  try {
    return statSync(LOG_PATH).size
  } catch {
    return 0
  }
}

// The log is shared by the packaged app and by any `pnpm dev` in any worktree, so the
// byte offset taken just before launch is the only thing that makes the slice ours.
async function readLogSlice(anchorOffset) {
  let handle
  try {
    handle = await open(LOG_PATH, 'r')
  } catch {
    return ''
  }

  try {
    const stats = await handle.stat()
    if (stats.size <= anchorOffset) {
      return ''
    }

    const buffer = Buffer.alloc(stats.size - anchorOffset)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, anchorOffset)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

async function fetchPageTarget(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!response.ok) {
      return null
    }
    const targets = await response.json()
    return targets.find((target) => target.type === 'page') ?? null
  } catch {
    return null
  }
}

async function waitForPageTarget(port) {
  const deadline = Date.now() + CDP_DEADLINE_MS
  while (Date.now() < deadline) {
    const target = await fetchPageTarget(port)
    if (target) {
      return target
    }
    await delay(CDP_POLL_MS)
  }

  throw new Error(`no CDP page target on port ${port} within ${CDP_DEADLINE_MS} ms`)
}

async function waitForLaunchRecord(anchorOffset) {
  const deadline = Date.now() + LOG_DEADLINE_MS
  while (Date.now() < deadline) {
    const slice = await readLogSlice(anchorOffset)
    const shownAt = findWindowShownAt(slice)
    const timeline = parseLaunchTimeline(slice)
    if (shownAt !== null && timeline) {
      return { slice, shownAt, timeline }
    }
    await delay(LOG_POLL_MS)
  }

  throw new Error(
    `log had no "main window shown" line plus a closed launch timeline block within ${LOG_DEADLINE_MS} ms`
  )
}

function connectCdp(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl)
    const pending = new Map()
    let nextId = 1

    const failPending = (error) => {
      for (const entry of pending.values()) {
        entry.reject(error)
      }
      pending.clear()
    }

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = pending.get(message.id)
      if (!entry) {
        return
      }
      pending.delete(message.id)
      if (message.error) {
        entry.reject(new Error(`CDP ${message.error.message}`))
      } else {
        entry.resolve(message.result)
      }
    })

    socket.addEventListener('error', () => {
      const error = new Error(`CDP socket failed: ${webSocketDebuggerUrl}`)
      failPending(error)
      reject(error)
    })

    socket.addEventListener('close', () => {
      failPending(new Error('CDP socket closed with requests in flight'))
    })

    socket.addEventListener('open', () => {
      resolve({
        send(method, params) {
          return new Promise((resolveSend, rejectSend) => {
            const id = nextId
            nextId += 1
            pending.set(id, { resolve: resolveSend, reject: rejectSend })
            socket.send(JSON.stringify({ id, method, params }))
          })
        },
        close() {
          socket.close()
        }
      })
    })
  })
}

const FCP_PRESENT_EXPRESSION = `performance
  .getEntriesByType('paint')
  .some((entry) => entry.name === 'first-contentful-paint')`

const RENDERER_METRICS_EXPRESSION = `(() => {
  const round = (value) => (typeof value === 'number' ? Math.round(value * 1000) / 1000 : undefined)
  const navigation = performance.getEntriesByType('navigation')[0]
  const paints = performance.getEntriesByType('paint')
  const paintAt = (name) => paints.find((entry) => entry.name === name)?.startTime
  return {
    firstPaintMs: round(paintAt('first-paint')),
    fcpMs: round(paintAt('first-contentful-paint')),
    domInteractiveMs: round(navigation?.domInteractive),
    domContentLoadedMs: round(navigation?.domContentLoadedEventEnd),
    loadEventMs: round(navigation?.loadEventEnd)
  }
})()`

async function readRendererMetrics(webSocketDebuggerUrl) {
  const client = await connectCdp(webSocketDebuggerUrl)

  try {
    // This app paints its first contentful frame after the load event, so waiting on
    // document.readyState samples only the runs whose FCP happened to land early and
    // silently drops the slow ones. Wait for the entry itself.
    const deadline = Date.now() + FCP_DEADLINE_MS
    while (Date.now() < deadline) {
      const seen = await client.send('Runtime.evaluate', {
        expression: FCP_PRESENT_EXPRESSION,
        returnByValue: true
      })
      if (seen.result?.value === true) {
        break
      }
      await delay(CDP_POLL_MS)
    }

    // Screencast frame timing is not a metric here: attaching CDP perturbs the renderer,
    // and the epic's exploratory run saw no first frame until +3.88 s. The performance
    // entries below were recorded before the attach, so reading them after load is safe.
    const evaluated = await client.send('Runtime.evaluate', {
      expression: RENDERER_METRICS_EXPRESSION,
      returnByValue: true
    })

    return evaluated.result?.value ?? {}
  } finally {
    client.close()
  }
}

function collectWarnings(record) {
  const warnings = []
  if (record.tier !== 'packaged') {
    warnings.push(`tier is "${record.tier}", wall-clock metrics are not comparable`)
  }
  if (record.timeline.rendererLoadedMs === undefined) {
    warnings.push('launch timeline had no rendererLoadedMs field')
  }
  if (record.renderer.fcpMs === undefined) {
    warnings.push('renderer reported no first-contentful-paint entry')
  }
  return warnings
}

async function measureRun({
  run,
  appPath,
  executableName,
  port,
  appMtimeMs,
  firstRunAfterAppChange
}) {
  await quitApp(appPath, executableName)
  await delay(SETTLE_MS)

  const anchorOffset = logSizeOrZero()
  const t0 = Date.now()
  const launch = spawnSync('open', [
    '-a',
    appPath,
    '--args',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*'
  ])

  if (launch.status !== 0) {
    throw new Error(
      `open -a ${appPath} exited ${launch.status}: ${String(launch.stderr ?? '').trim()}`
    )
  }

  const target = await waitForPageTarget(port)
  const cdpAttachOffsetMs = Date.now() - t0

  const { slice, shownAt, timeline } = await waitForLaunchRecord(anchorOffset)
  const renderer = await readRendererMetrics(target.webSocketDebuggerUrl)
  const tier = detectTier(slice)

  const record = {
    run,
    tier,
    tierLabel: TIERS[tier].label,
    appMtimeMs,
    firstRunAfterAppChange,
    t0Iso: new Date(t0).toISOString(),
    clickToShownMs: shownAt - t0,
    cdpAttachOffsetMs,
    timeline,
    renderer,
    warnings: [],
    appVersion: detectAppVersion(slice)
  }
  record.warnings = collectWarnings(record)

  return record
}

async function runBench(options) {
  const executableName = readBundleExecutable(options.appPath)
  if (!executableName) {
    throw new Error(`no CFBundleExecutable in ${options.appPath}/Contents/Info.plist`)
  }
  const appMtimeMs = readAppMtimeMs(options.appPath, executableName)
  let firstRunAfterAppChange = readStoredAppMtimeMs() !== appMtimeMs

  const startedAt = new Date().toISOString()
  const runs = []
  const failures = []

  for (let run = 1; run <= options.runs; run += 1) {
    try {
      const record = await measureRun({
        run,
        appPath: options.appPath,
        executableName,
        port: options.port,
        appMtimeMs,
        firstRunAfterAppChange
      })
      runs.push(record)
      console.log(JSON.stringify(record))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ run, message })
      console.error(`run ${run} failed: ${message}`)
    }

    if (run === 1) {
      mkdirSync(PERF_DIR, { recursive: true })
      writeFileSync(APP_MTIME_STAMP, `${appMtimeMs}\n`)
      firstRunAfterAppChange = false
    }
  }

  const summary = summarize(runs)
  const appVersion = runs.find((record) => record.appVersion)?.appVersion ?? 'unknown version'

  console.log('')
  console.log(`${options.appPath} (${appVersion})`)
  console.log(formatMedianTable(summary, runs))

  mkdirSync(PERF_DIR, { recursive: true })
  const reportPath = path.join(PERF_DIR, `launch-bench-${startedAt.replaceAll(':', '-')}.json`)
  writeFileSync(
    reportPath,
    `${JSON.stringify({ app: options.appPath, appMtimeMs, startedAt, runs, summary }, null, 2)}\n`
  )
  console.log(reportPath)

  if (failures.length > 0) {
    console.error('')
    for (const failure of failures) {
      console.error(`failed run ${failure.run}: ${failure.message}`)
    }
    process.exitCode = 1
  }
}

async function runCli() {
  const options = parseArgs(process.argv.slice(2))
  acquireLock()

  try {
    await runBench(options)
  } finally {
    releaseLock()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
