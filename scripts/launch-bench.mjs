#!/usr/bin/env node
// Launch bench for the Tauri app. Each run starts the app on a bench profile, reads the shell's
// `launch timeline {` block and the renderer's `renderer launch marks {json}` line from
// `main.log`, then quits it. No debugger attaches: every number is one the app logs itself.

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG_FILE, seedVaultRegistry } from '../apps/desktop-tauri/e2e/harness/seed-registry.mjs'

const IDENTIFIER = 'com.memrynote.memry'
// A device of its own keeps every launch off the user's keychain accounts, log, data dir and
// single-instance lock (`memry_desktop::paths::profile_identifier`).
const BENCH_DEVICE = 'launch-bench'
// Any other device (`dev`, the `A`/`B`/`C` of `tauri:dev:a`) may hold a signed-in account.
const BENCH_DEVICE_PATTERN = /^launch-bench(?:-[a-z0-9]+)?$/
// A `target/debug/` build (including `tauri build --debug` bundles) logs `(packaged)` too.
const DEBUG_BUILD_PATTERN = /[\\/]target[\\/](?:[^\\/]+[\\/])?debug[\\/]/
const LOCK_DIR = path.join(tmpdir(), 'memry-launch-bench.lock')
const PERF_DIR = fileURLToPath(new URL('../.perf/', import.meta.url))
const APP_MTIME_STAMP = path.join(PERF_DIR, 'last-app-mtime')

const DEFAULT_RUNS = 5
const DEFAULT_VAULT = path.join(homedir(), 'MemryBenchVault')
// Kept across runs and invocations: the web view profile inside it holds the tab state, so a
// note left open in it is the note every later launch restores.
const DEFAULT_PROFILE = path.join(tmpdir(), 'memry-launch-bench', 'profile')

const SETTLE_MS = 2_000
const QUIT_DEADLINE_MS = 20_000
const LOG_DEADLINE_MS = 45_000
// The renderer reports when the note-readable mark lands, or 8 s after `load` on a launch that
// restored no note (`NOTE_READABLE_WAIT_MS`, `lib/launch-marks.ts`); this covers both.
const RENDERER_DEADLINE_MS = 20_000
const POLL_MS = 100

const LOG_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\b/
const STARTING_LINE_PATTERN = /MemryNote (\S+) starting \((packaged|dev)\)/
const TIMELINE_FIELD_PATTERN = /^([A-Za-z][A-Za-z0-9]*): (.+?),?$/
const RENDERER_MARKS_PREFIX = 'renderer launch marks '

export const TIERS = {
  packaged: { label: 'packaged (tier 3)', wallClockValid: true },
  dev: { label: 'dev build', wallClockValid: false },
  debug: { label: 'debug build', wallClockValid: false },
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
  {
    key: 'renderer_note_readable_ms',
    read: (run) => run.renderer?.noteReadableMs,
    tier3Only: false
  }
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

/** The last `renderer launch marks {json}` line, or null when there is none or it is not JSON. */
export function parseRendererMarks(slice) {
  const line = slice.split('\n').findLast((candidate) => candidate.includes(RENDERER_MARKS_PREFIX))
  if (!line) {
    return null
  }

  try {
    const marks = JSON.parse(
      line.slice(line.indexOf(RENDERER_MARKS_PREFIX) + RENDERER_MARKS_PREFIX.length)
    )
    return marks && typeof marks === 'object' ? marks : null
  } catch {
    return null
  }
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

/** The starting line's tier, or `debug` for a debug or e2e build, whose wall clock is not tier 3. */
export function classifyBuild(slice, executable, env) {
  if (DEBUG_BUILD_PATTERN.test(executable) || env.MEMRY_E2E === '1') {
    return 'debug'
  }
  return detectTier(slice)
}

/** The environment of every launch: a bench device on the bench profile. */
export function benchEnv(processEnv, profile) {
  const device =
    processEnv.MEMRY_DEVICE === '' ? BENCH_DEVICE : (processEnv.MEMRY_DEVICE ?? BENCH_DEVICE).trim()
  if (!BENCH_DEVICE_PATTERN.test(device)) {
    throw new Error(
      `MEMRY_DEVICE=${JSON.stringify(device)} may hold a signed-in account; unset it or use launch-bench-<a-z0-9>`
    )
  }
  return { ...processEnv, MEMRY_DEVICE: device, MEMRY_APP_DATA_DIR: profile }
}

/** Tauri's `app_data_dir` of the production identifier: the user's real profile. */
function defaultDataDir(env, platform, home) {
  if (platform === 'darwin') {
    return path.join(home, 'Library/Application Support', IDENTIFIER)
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.win32.join(home, 'AppData', 'Roaming')
    return path.win32.join(appData, IDENTIFIER)
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), IDENTIFIER)
}

/**
 * Refuses the real profile, by name or through a link, and creates the bench profile:
 * `prepareProfile` rewrites its `memry-config.json`.
 */
export function checkProfile(profile, env, platform, home) {
  const realProfile = defaultDataDir(env, platform, home)
  const refuse = () => new Error(`${profile} is the real profile; pass a bench --profile`)
  // The default macOS and Windows file systems ignore case.
  const resolve = (dir) =>
    platform === 'linux'
      ? path.posix.resolve(dir)
      : (platform === 'win32' ? path.win32 : path.posix).resolve(dir).toLowerCase()
  if (resolve(profile) === resolve(realProfile)) {
    throw refuse()
  }
  mkdirSync(profile, { recursive: true })
  if (
    existsSync(realProfile) &&
    realpathSync.native(profile) === realpathSync.native(realProfile)
  ) {
    throw refuse()
  }
}

function hasNoteReadableMark(record) {
  return record.renderer?.noteReadableMs != null
}

/** A failure for each run with no note-readable mark while another run of the bench had one. */
export function noteReadableFailures(runs) {
  if (!runs.some(hasNoteReadableMark)) {
    return []
  }
  return runs
    .filter((record) => !hasNoteReadableMark(record))
    .map((record) => ({
      run: record.run,
      message:
        record.renderer === null
          ? 'no "renderer launch marks" line, while another run had a note-readable mark'
          : 'no note-readable mark, while another run had one'
    }))
}

export function median(numbers) {
  const sorted = numbers.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b)
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

/**
 * `main.log` of the app's profile: Tauri's `app_log_dir` for the identifier the app derives from
 * `MEMRY_DEVICE` (`memry_desktop::paths::profile_identifier`), unless `MEMRY_TEST_LOG_DIR`
 * replaces the directory.
 */
export function logPath(env, platform, home) {
  if (env.MEMRY_TEST_LOG_DIR) {
    return path.join(env.MEMRY_TEST_LOG_DIR, 'main.log')
  }
  const identifier = env.MEMRY_DEVICE ? `${IDENTIFIER}.${env.MEMRY_DEVICE}` : IDENTIFIER
  if (platform === 'darwin') {
    return path.join(home, 'Library/Logs', identifier, 'main.log')
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local')
    return path.win32.join(localAppData, identifier, 'logs', 'main.log')
  }
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local/share')
  return path.join(dataHome, identifier, 'logs', 'main.log')
}

/** Where an install puts the app; Linux has no fixed place (the AppImage runs from anywhere). */
export function defaultAppPath(env, platform, home) {
  if (platform === 'darwin') {
    return '/Applications/MemryNote.app'
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local')
    return path.win32.join(localAppData, 'MemryNote', 'current', 'Memrynote.exe')
  }
  return null
}

// The bundle directory can be renamed (two builds kept side by side for an A/B), so the
// executable name comes from Info.plist rather than from the directory name. An AppImage hides
// its layout, and Electron's would run on the user's real profile, so it needs `--tauri-appimage`.
export function resolveExecutable(appPath, { tauriAppImage = false } = {}) {
  if (appPath.endsWith('.AppImage')) {
    if (!tauriAppImage) {
      throw new Error(
        `${appPath} may be an Electron build; pass --tauri-appimage if it is the Tauri app`
      )
    }
    return appPath
  }
  if (!appPath.endsWith('.app')) {
    if (existsSync(path.join(path.dirname(appPath), 'resources', 'app.asar'))) {
      throw new Error(`${appPath} is an Electron build; this bench measures the Tauri app`)
    }
    return appPath
  }
  if (existsSync(path.join(appPath, 'Contents/Frameworks/Electron Framework.framework'))) {
    throw new Error(`${appPath} is an Electron build; this bench measures the Tauri app`)
  }
  const plist = readFileSync(path.join(appPath, 'Contents/Info.plist'), 'utf8')
  const name = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
  if (!name) {
    throw new Error(`no CFBundleExecutable in ${appPath}/Contents/Info.plist`)
  }
  return path.join(appPath, 'Contents/MacOS', name)
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

const USAGE =
  'Usage: node scripts/launch-bench.mjs [--runs 5] [--app <MemryNote.app | executable>] [--tauri-appimage] [--vault ~/MemryBenchVault] [--profile <dir>]'

function parseArgs(argv) {
  const defaultApp = defaultAppPath(process.env, process.platform, homedir())
  const options = {
    runs: DEFAULT_RUNS,
    appPath: defaultApp,
    vault: DEFAULT_VAULT,
    profile: DEFAULT_PROFILE,
    tauriAppImage: false
  }
  const paths = { '--app': 'appPath', '--vault': 'vault', '--profile': 'profile' }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--tauri-appimage') {
      options.tauriAppImage = true
      continue
    }
    if (arg === '--runs') {
      options.runs = readPositiveInteger(readRequiredValue(argv, index, arg), arg)
    } else if (paths[arg]) {
      options[paths[arg]] = path.resolve(readRequiredValue(argv, index, arg))
    } else {
      throw new Error(`Unknown argument: ${arg}\n${USAGE}`)
    }
    index += 1
  }

  if (!options.appPath) {
    throw new Error(`--app is required on ${process.platform}\n${USAGE}`)
  }
  return options
}

let lockHeld = false
let running = null

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
  console.error(`If that pid is dead, remove the lock directory: ${LOCK_DIR}`)
  process.exit(1)
}

function acquireLock() {
  try {
    mkdirSync(path.dirname(LOCK_DIR), { recursive: true })
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
      if (running) {
        forceKill(running)
      }
      releaseLock()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readStoredAppMtimeMs() {
  try {
    const stored = Number(readFileSync(APP_MTIME_STAMP, 'utf8').trim())
    return Number.isFinite(stored) ? stored : null
  } catch {
    return null
  }
}

function logSizeOrZero(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

// The log is shared with any other launch of the same profile identifier, so the byte offset
// taken just before launch is what makes the slice ours.
async function readLogSlice(file, anchorOffset) {
  let handle
  try {
    handle = await open(file, 'r')
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

async function waitForLog(file, anchorOffset, deadlineMs, found) {
  const deadline = Date.now() + deadlineMs
  let slice = ''
  while (Date.now() < deadline) {
    slice = await readLogSlice(file, anchorOffset)
    if (found(slice)) {
      return slice
    }
    await delay(POLL_MS)
  }
  return null
}

function launch(executable, env) {
  const child = spawn(executable, [], { env, stdio: 'ignore' })
  const exited = new Promise((resolve) => {
    child.once('exit', resolve)
    child.once('error', resolve)
  })
  return { child, exited }
}

function forceKill({ child }) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
}

/** Asks the app to quit (SIGTERM starts its shutdown; Windows gets WM_CLOSE), then forces it. */
async function quit(app) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(app.child.pid)], { stdio: 'ignore' })
  } else {
    app.child.kill('SIGTERM')
  }
  const timedOut = Symbol('timeout')
  const outcome = await Promise.race([app.exited, delay(QUIT_DEADLINE_MS).then(() => timedOut)])
  if (outcome !== timedOut) {
    return null
  }
  forceKill(app)
  await app.exited
  return `the app did not quit within ${QUIT_DEADLINE_MS} ms and was killed`
}

function prepareProfile(profile, vault) {
  if (!existsSync(path.join(vault, '.memry'))) {
    throw new Error(`${vault} is not a vault; seed it first (pnpm seed1k)`)
  }
  let current = null
  try {
    current = JSON.parse(readFileSync(path.join(profile, CONFIG_FILE), 'utf8')).currentVault
  } catch {
    // A fresh profile.
  }
  // Rewritten only when it names another vault: the app keeps its own fields in this file.
  if (current !== vault) {
    seedVaultRegistry(profile, vault)
  }
}

export function collectWarnings(record) {
  const warnings = []
  if (record.tier !== 'packaged') {
    warnings.push(`tier is "${record.tier}", wall-clock metrics are not comparable`)
  }
  if (record.timeline.rendererLoadedMs === undefined) {
    warnings.push('launch timeline had no rendererLoadedMs field')
  }
  if (!record.renderer) {
    warnings.push('no "renderer launch marks" line')
  } else if (record.renderer.fcpMs == null) {
    warnings.push('renderer reported no first-contentful-paint entry')
  }
  if (record.renderer && record.renderer.noteReadableMs == null) {
    warnings.push(
      'no note-readable mark within 8 s of load: with no note restored, open one in the bench profile once, quit, and rerun'
    )
  }
  if (record.quitWarning) {
    warnings.push(record.quitWarning)
  }
  return warnings
}

async function measureRun({ run, executable, log, env, appMtimeMs, firstRunAfterAppChange }) {
  await delay(SETTLE_MS)

  const anchorOffset = logSizeOrZero(log)
  const t0 = Date.now()
  const app = launch(executable, env)
  running = app

  try {
    const slice = await waitForLog(
      log,
      anchorOffset,
      LOG_DEADLINE_MS,
      (text) => findWindowShownAt(text) !== null && parseLaunchTimeline(text) !== null
    )
    if (slice === null) {
      throw new Error(
        `${log} had no "main window shown" line plus a closed launch timeline block within ${LOG_DEADLINE_MS} ms`
      )
    }
    const withRenderer = await waitForLog(
      log,
      anchorOffset,
      RENDERER_DEADLINE_MS,
      (text) => parseRendererMarks(text) !== null
    )
    const tier = classifyBuild(slice, executable, env)

    const record = {
      run,
      tier,
      tierLabel: TIERS[tier].label,
      appMtimeMs,
      firstRunAfterAppChange,
      t0Iso: new Date(t0).toISOString(),
      clickToShownMs: findWindowShownAt(slice) - t0,
      timeline: parseLaunchTimeline(slice),
      renderer: withRenderer === null ? null : parseRendererMarks(withRenderer),
      warnings: [],
      appVersion: STARTING_LINE_PATTERN.exec(slice)?.[1] ?? null
    }
    record.quitWarning = await quit(app)
    record.warnings = collectWarnings(record)
    delete record.quitWarning
    return record
  } catch (error) {
    if (app.child.exitCode === null) {
      await quit(app)
    }
    throw error
  } finally {
    running = null
  }
}

async function runBench(options) {
  const executable = resolveExecutable(options.appPath, options)
  checkProfile(options.profile, process.env, process.platform, homedir())
  const env = benchEnv(process.env, options.profile)
  const log = logPath(env, process.platform, homedir())
  prepareProfile(options.profile, options.vault)

  const appMtimeMs = statSync(executable).mtimeMs
  let firstRunAfterAppChange = readStoredAppMtimeMs() !== appMtimeMs

  const startedAt = new Date().toISOString()
  const runs = []
  const failures = []

  for (let run = 1; run <= options.runs; run += 1) {
    try {
      const record = await measureRun({
        run,
        executable,
        log,
        env,
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

  failures.push(...noteReadableFailures(runs))
  failures.sort((a, b) => a.run - b.run)

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
