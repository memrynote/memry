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
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import * as path from 'node:path'

/** The film's size in CSS px: it fits a 14 inch MacBook (1512x982 points) beside the menu bar. */
export const FILM = { width: 1440, height: 810 }
/** Calibration frames are compared at this size, in grayscale. */
export const PROBE = { width: 160, height: 90 }
/** Mean absolute difference, of 255, above which the window is not what the screen shows. */
export const CALIBRATION_LIMIT = 6
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

/** Throws `Window calibration failed` when the two probes differ by more than the limit. */
export function checkCalibration(screen, driver, limit = CALIBRATION_LIMIT) {
  const diff = meanAbsDiff(screen, driver)
  if (diff > limit) {
    throw new Error(
      `Window calibration failed: the screen and the WebDriver screenshot differ by ` +
        `${diff.toFixed(1)} of 255 (limit ${limit}). Is another window over the app, or is ` +
        `MEMRY_FILM_SCREEN not the main display?`
    )
  }
  return diff
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

/** The screen backend of rec.mjs: `start` places, calibrates and records; `stop` ends it. */
export class ScreenRecorder {
  constructor(browser, { film = FILM, env = process.env } = {}) {
    this.browser = browser
    this.film = film
    this.env = env
    this.scale = requiredScale(env)
  }

  async start(dir) {
    if (process.platform !== 'darwin') throw new Error('Filming runs on macOS')
    const index = pickScreen(listDevices(), this.env)
    const region = await placeWindow(this.browser, this.film, this.scale)
    const crop = cropFilter(region, this.scale)
    const { client, sessionId } = this.browser
    const screen = grayProbe(avfoundationInput(index), `${crop},${PROBE_FILTER}`)
    const driver = grayProbe(
      ['-f', 'png_pipe', '-i', '-'],
      PROBE_FILTER,
      await client.screenshot(sessionId)
    )
    this.calibration = checkCalibration(screen, driver)

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
    let stderr = ''
    this.ffmpeg.stderr.on('data', (chunk) => (stderr += chunk))
    this.exited = new Promise((done) => this.ffmpeg.once('exit', (code) => done(code)))
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

  /** Ends the recording; returns the wall-clock time of its first frame, in seconds. */
  async stop() {
    this.ffmpeg.stdin.end('q')
    const code = await this.exited
    if (code !== 0) throw new Error(`ffmpeg ended the recording with code ${code}`)
    const start = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', this.raw],
      { encoding: 'utf8' }
    )
    return Number(start)
  }
}
