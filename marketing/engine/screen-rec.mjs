// Records the app window from the macOS screen with ffmpeg (avfoundation). WebDriver has no
// screencast, so the film is cut from a recording of the display, cropped to the window's
// content. The OS cursor is left out; the fake DOM cursor of rec.mjs is in the page.
//
// Before every take the window is placed at the main display's origin and sized until its
// content is the film size, and one cropped screen frame is compared with the WebDriver
// screenshot, so a covered or misplaced window aborts the take instead of filming the wrong
// pixels. Environment: MEMRY_FILM_SCREEN (the avfoundation index of the main display, default
// the first "Capture screen"), MEMRY_FILM_SCALE (the devicePixelRatio filming needs, default 2;
// 1 is for a test take on a non-Retina display, never for a film).
//
// Turn on Do Not Disturb before a take: a notification banner over the window is filmed. The
// calibration fails on the worst tile, so a banner present at the start or at the end of the take
// aborts it, but one that comes and goes mid-take is not caught.
//
// One take at a time across agents and slots (the record lock): two takes would film each other.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

/** The film's size in CSS px: it fits a 14 inch MacBook (1512x982 points) beside the menu bar. */
export const FILM = { width: 1440, height: 810 }
/** Calibration frames are compared at this size, in grayscale. */
export const PROBE = { width: 160, height: 90 }
/** Mean absolute difference, of 255, above which the window is not what the screen shows. */
export const CALIBRATION_LIMIT = 6
/**
 * The same, for the worst of the probe's 16x9 tiles (90x90 film px each): a notification banner
 * covers about 2% of the film, too little to move the mean of the whole frame.
 */
export const TILE_LIMIT = 20
const TILES = { cols: 16, rows: 9 }
/** How long a stopped recorder may take to finish its file before it is killed. */
const ABORT_GRACE_MS = 2000
/**
 * ffmpeg stops reading the screen after this long, the last backstop when this process is killed
 * with SIGKILL and no handler runs. No take is near it.
 */
export const MAX_TAKE_SECONDS = 1800
/** A lock dir with no owner file older than this is a take that crashed while taking it. */
const OWNERLESS_LOCK_MS = 5000
/** The signals that end this process while a recording runs. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']
export const RECORD_LOCK = '/tmp/memry-social/record.lock'
const SIZE_ATTEMPTS = 5
const FIRST_FRAME_TIMEOUT_MS = 10_000

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** The screen devices of `ffmpeg -f avfoundation -list_devices true -i ""` output. */
export function screenDevices(listing) {
  return [...listing.matchAll(/\[(\d+)\] (Capture screen \d+)/g)].map((m) => ({
    index: Number(m[1]),
    name: m[2]
  }))
}

export function pickScreen(listing, env = process.env) {
  if (env.MEMRY_FILM_SCREEN !== undefined && env.MEMRY_FILM_SCREEN !== '') {
    return Number(env.MEMRY_FILM_SCREEN)
  }
  const [first] = screenDevices(listing)
  if (!first) throw new Error('ffmpeg lists no "Capture screen" device')
  return first.index
}

export const requiredScale = (env = process.env) => Number(env.MEMRY_FILM_SCALE ?? 2)

/**
 * Where the content of a window with outer `rect` sits on screen, in points: macOS draws the
 * window chrome (none with the overlay title bar) above the content and no side border.
 */
export function contentRegion(rect, film = FILM) {
  return {
    x: rect.x + (rect.width - film.width) / 2,
    y: rect.y + rect.height - film.height,
    width: film.width,
    height: film.height
  }
}

/** The ffmpeg crop of `region` (points) on a display of `scale` pixels per point. */
export const cropFilter = (region, scale) =>
  `crop=${Math.round(region.width * scale)}:${Math.round(region.height * scale)}:` +
  `${Math.round(region.x * scale)}:${Math.round(region.y * scale)}`

export function meanAbsDiff(a, b) {
  if (a.length !== b.length || a.length === 0) {
    throw new Error(`calibration frames differ in size (${a.length} and ${b.length} bytes)`)
  }
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

/** The largest mean absolute difference of one tile of two PROBE-sized frames. */
export function worstTileDiff(a, b, probe = PROBE, tiles = TILES) {
  meanAbsDiff(a, b)
  const tw = probe.width / tiles.cols
  const th = probe.height / tiles.rows
  let worst = 0
  for (let row = 0; row < tiles.rows; row += 1) {
    for (let col = 0; col < tiles.cols; col += 1) {
      let sum = 0
      for (let y = row * th; y < (row + 1) * th; y += 1) {
        for (let x = col * tw; x < (col + 1) * tw; x += 1) {
          const i = y * probe.width + x
          sum += Math.abs(a[i] - b[i])
        }
      }
      worst = Math.max(worst, sum / (tw * th))
    }
  }
  return worst
}

/**
 * Throws `Window calibration failed` when the two probes differ by more than the limit, over the
 * whole frame or in one tile. Returns the whole-frame difference.
 */
export function checkCalibration(
  screen,
  driver,
  limit = CALIBRATION_LIMIT,
  tileLimit = TILE_LIMIT
) {
  const diff = meanAbsDiff(screen, driver)
  const tile = worstTileDiff(screen, driver)
  if (diff > limit || tile > tileLimit) {
    throw new Error(
      `Window calibration failed: the screen and the WebDriver screenshot differ by ` +
        `${diff.toFixed(1)} of 255 (limit ${limit}), ${tile.toFixed(1)} in the worst tile ` +
        `(limit ${tileLimit}). Is another window or a notification over the app (turn on Do Not ` +
        `Disturb), or is MEMRY_FILM_SCREEN not the main display?`
    )
  }
  return diff
}

/**
 * Waits for the record lock and returns its release. A lock whose owner process is gone is taken
 * over. `owner` names the take in the wait message.
 */
export async function takeRecordLock(owner, lock = RECORD_LOCK) {
  mkdirSync(path.dirname(lock), { recursive: true })
  const ownerFile = path.join(lock, 'owner')
  for (let waited = 0; ; waited += 2) {
    try {
      mkdirSync(lock)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const who = lockHolder(lock, ownerFile)
      if (who === undefined) rmSync(lock, { recursive: true, force: true })
      else if (waited % 30 === 0) console.log(`  waiting for ${who} take to finish...`)
      await sleep(2000)
      continue
    }
    try {
      // Readable by this user only: the lock lives in the shared /tmp.
      writeFileSync(ownerFile, `${process.pid} ${owner}`, { mode: 0o600 })
    } catch (error) {
      rmSync(lock, { recursive: true, force: true })
      throw error
    }
    let held = true
    return () => {
      if (held) rmSync(lock, { recursive: true, force: true })
      held = false
    }
  }
}

/**
 * The take holding `lock`, or undefined when the lock is stale: its owner process is gone, or it
 * names no owner and is older than a crash between creating it and naming the owner.
 */
function lockHolder(lock, ownerFile) {
  const [pid, who = 'another'] = existsSync(ownerFile)
    ? readFileSync(ownerFile, 'utf8').split(' ')
    : []
  // No pid, or an empty owner file (a crash inside its write). Not 0 either: signal 0 to pid 0
  // reaches this process's own group and always succeeds.
  if (!/^[1-9]\d*$/.test(pid ?? '')) {
    let age = 0
    try {
      age = Date.now() - statSync(lock).mtimeMs
    } catch {
      // Released between the two checks: the next attempt takes it.
      return undefined
    }
    return age > OWNERLESS_LOCK_MS ? undefined : 'another'
  }
  try {
    process.kill(Number(pid), 0)
    return who
  } catch (error) {
    // EPERM: the owner runs as another user, so it is alive.
    return error.code === 'EPERM' ? who : undefined
  }
}

// avfoundation offers no yuv420p, ffmpeg's default ask, so the pixel format is named.
const avfoundationInput = (index) => [
  '-f',
  'avfoundation',
  '-pixel_format',
  'uyvy422',
  '-framerate',
  '60',
  '-capture_cursor',
  '0',
  '-i',
  `${index}:none`
]

const PROBE_FILTER = `scale=${PROBE.width}:${PROBE.height}:flags=area,format=gray`

/** One frame of `input` args, reduced to the probe size in grayscale. */
const grayProbe = (inputArgs, filter = PROBE_FILTER, stdin) =>
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputArgs,
      '-frames:v',
      '1',
      '-vf',
      filter,
      '-f',
      'rawvideo',
      '-'
    ],
    { input: stdin, maxBuffer: 1 << 20 }
  )

function listDevices() {
  try {
    execFileSync(
      'ffmpeg',
      ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
      {
        stdio: ['ignore', 'ignore', 'pipe']
      }
    )
  } catch (error) {
    // ffmpeg exits 1 after listing, since "" is no input.
    return String(error.stderr ?? '')
  }
  return ''
}

/**
 * Sizes the window until its content is the film size, at the main display's origin. Returns
 * the content's region on screen in points.
 */
export async function placeWindow({ client, sessionId }, film = FILM, scale = requiredScale()) {
  let size = { width: film.width, height: film.height }
  for (let attempt = 0; attempt < SIZE_ATTEMPTS; attempt += 1) {
    await client.setWindowRect(sessionId, { x: 0, y: 0, ...size })
    await sleep(300)
    const [width, height, ratio] = await client.execute(
      sessionId,
      'return [innerWidth, innerHeight, devicePixelRatio]',
      []
    )
    if (ratio !== scale) {
      throw new Error(
        `The window renders at devicePixelRatio ${ratio}; filming needs ${scale}. Film on a ` +
          'Retina display (MEMRY_FILM_SCALE=1 allows a test take on a 1x display).'
      )
    }
    if (width === film.width && height === film.height) {
      return contentRegion(await client.windowRect(sessionId), film)
    }
    size = { width: size.width + film.width - width, height: size.height + film.height - height }
  }
  throw new Error(`The window content did not reach ${film.width}x${film.height}`)
}

/**
 * The screen backend of rec.mjs: `start` takes the record lock, places, calibrates and records;
 * `stop` ends the recording and calibrates its last frame again; `abort` ends it after a failed
 * take and deletes the file. Each releases the lock.
 */
export class ScreenRecorder {
  constructor(browser, { film = FILM, env = process.env, lock = RECORD_LOCK } = {}) {
    this.browser = browser
    this.film = film
    this.env = env
    this.lock = lock
    this.scale = requiredScale(env)
  }

  async start(dir) {
    if (process.platform !== 'darwin') throw new Error('Filming runs on macOS')
    this.release = await takeRecordLock(path.basename(path.resolve(dir, '../..')), this.lock)
    const index = pickScreen(listDevices(), this.env)
    const region = await placeWindow(this.browser, this.film, this.scale)
    const crop = cropFilter(region, this.scale)
    const screen = grayProbe(avfoundationInput(index), `${crop},${PROBE_FILTER}`)
    this.calibration = checkCalibration(screen, await this.driverProbe())

    this.raw = path.join(dir, 'raw.mkv')
    // Wall-clock timestamps kept in the file (-copyts) date the first frame, so the take can be
    // trimmed to the moment the recorder's clock starts.
    this.ffmpeg = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-use_wallclock_as_timestamps',
        '1',
        '-t',
        String(MAX_TAKE_SECONDS),
        ...avfoundationInput(index),
        '-vf',
        crop,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-qp',
        '0',
        '-copyts',
        this.raw
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] }
    )
    this.watch(this.ffmpeg)
    let stderr = ''
    this.ffmpeg.stderr.on('data', (chunk) => (stderr += chunk))
    // The muxer writes its header once the first frame is encoded.
    const deadline = Date.now() + FIRST_FRAME_TIMEOUT_MS
    while (!(existsSync(this.raw) && statSync(this.raw).size > 0)) {
      if (this.ffmpeg.exitCode !== null || Date.now() >= deadline) {
        this.ffmpeg.kill('SIGKILL')
        throw new Error(
          `The screen recording did not start: ${stderr.trim() || 'no frame in 10 s'}`
        )
      }
      await sleep(20)
    }
    return { width: this.film.width, height: this.film.height, scale: this.scale }
  }

  /**
   * Keeps `exited` for the recording child, and kills it when this process exits or gets SIGINT,
   * SIGTERM or SIGHUP first (the signal is raised again once the child is killed and the lock
   * freed): ffmpeg ignores the end of its stdin and would film the screen until killed.
   */
  watch(child) {
    this.ffmpeg = child
    // `q` written after ffmpeg died fails with EPIPE; the recording has ended either way.
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') console.error(`  ffmpeg stdin: ${error.message}`)
    })
    const kill = () => child.kill('SIGKILL')
    const onSignal = (signal) => {
      kill()
      this.release?.()
      unwatch()
      process.kill(process.pid, signal)
    }
    const unwatch = () => {
      process.off('exit', kill)
      for (const signal of STOP_SIGNALS) process.off(signal, onSignal)
    }
    process.once('exit', kill)
    // `on`, not `once`: with no listener left, a second signal before this one is handled would
    // take the default action and end this process with ffmpeg still filming. unwatch removes them.
    for (const signal of STOP_SIGNALS) process.on(signal, onSignal)
    this.exited = new Promise((done) =>
      child.once('exit', (code) => {
        unwatch()
        done(code)
      })
    )
  }

  /** The WebDriver screenshot, reduced to the probe. */
  async driverProbe() {
    const { client, sessionId } = this.browser
    return grayProbe(
      ['-f', 'png_pipe', '-i', '-'],
      PROBE_FILTER,
      await client.screenshot(sessionId)
    )
  }

  /**
   * Ends the recording; returns the wall-clock time of its first frame, in seconds. Throws
   * `Window calibration failed` when the recording's frame at the last WebDriver screenshot is not
   * the app: a window or a banner covered it at the end of the take.
   */
  async stop() {
    try {
      const shotAt = Date.now() / 1000
      const driver = await this.driverProbe()
      this.ffmpeg.stdin.end('q')
      const code = await this.exited
      if (code !== 0) throw new Error(`ffmpeg ended the recording with code ${code}`)
      const start = Number(
        execFileSync(
          'ffprobe',
          ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', this.raw],
          { encoding: 'utf8' }
        )
      )
      // Without -seek_timestamp, -ss counts from the file's first frame.
      const last = grayProbe(['-ss', (shotAt - start).toFixed(3), '-i', this.raw])
      this.endCalibration = checkCalibration(last, driver)
      return start
    } finally {
      this.release?.()
    }
  }

  /** Ends a failed take: stops ffmpeg (killed after a grace), deletes the file, frees the lock. */
  async abort() {
    try {
      const child = this.ffmpeg
      if (child?.exitCode === null && child.signalCode === null) {
        if (child.stdin.writable) child.stdin.end('q')
        const timer = setTimeout(() => child.kill('SIGKILL'), ABORT_GRACE_MS)
        await this.exited
        clearTimeout(timer)
      }
      if (this.raw) rmSync(this.raw, { force: true })
    } finally {
      this.release?.()
    }
  }
}
