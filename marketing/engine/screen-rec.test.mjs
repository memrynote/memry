import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { segments, screenFilter } from '../tutorials/engine/encode.mjs'
import { record } from '../tutorials/engine/record.mjs'
import {
  CALIBRATION_LIMIT,
  ScreenRecorder,
  TILE_LIMIT,
  checkCalibration,
  contentRegion,
  cropFilter,
  meanAbsDiff,
  pickScreen,
  placeWindow,
  takeRecordLock,
  worstTileDiff
} from './screen-rec.mjs'

const LISTING = `[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] C922 Pro Stream Webcam
[AVFoundation indev @ 0x1] [1] MacBook Pro Camera
[AVFoundation indev @ 0x1] [3] Capture screen 0
[AVFoundation indev @ 0x1] [4] Capture screen 1
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone`

test('the screen is the first Capture screen unless MEMRY_FILM_SCREEN names one', () => {
  assert.equal(pickScreen(LISTING, {}), 3)
  assert.equal(pickScreen(LISTING, { MEMRY_FILM_SCREEN: '4' }), 4)
  assert.throws(() => pickScreen('[0] Camera', {}), /no "Capture screen"/)
})

test('calibration passes a matching frame and fails a shifted one', () => {
  const frame = Uint8Array.from({ length: 160 * 90 }, (_, i) => (i % 160 < 80 ? 30 : 220))
  const noisy = frame.map((v, i) => v + (i % 3) - 1)
  assert.ok(checkCalibration(frame, noisy) < 1)
  // The same picture 20 px to the right: the window is not where the crop looks.
  const shifted = frame.map((_, i) => (i % 160 < 100 ? 30 : 220))
  assert.ok(meanAbsDiff(frame, shifted) > CALIBRATION_LIMIT)
  assert.throws(() => checkCalibration(frame, shifted), /Window calibration failed/)
  assert.throws(() => meanAbsDiff(frame, frame.subarray(1)), /differ in size/)
})

test('the crop is the window content in display pixels', () => {
  // The overlay title bar draws over the content: the outer rect is the content.
  const region = contentRegion({ x: 0, y: 33, width: 1440, height: 810 })
  assert.deepEqual(region, { x: 0, y: 33, width: 1440, height: 810 })
  assert.equal(cropFilter(region, 2), 'crop=2880:1620:0:66')
  // A window with a 28 pt title bar above its content.
  assert.deepEqual(contentRegion({ x: 0, y: 25, width: 1440, height: 838 }).y, 53)
})

test('placeWindow grows the window until the content is the film size', async () => {
  const calls = []
  const client = {
    async setWindowRect(_, rect) {
      calls.push(rect)
      this.rect = { ...rect, y: 25 }
    },
    async execute() {
      // 28 pt of chrome above the content, 2x display.
      return [this.rect.width, this.rect.height - 28, 2]
    },
    async windowRect() {
      return this.rect
    }
  }
  const region = await placeWindow({ client, sessionId: 's' }, { width: 1440, height: 810 }, 2)
  assert.deepEqual(calls.at(-1), { x: 0, y: 0, width: 1440, height: 838 })
  assert.deepEqual(region, { x: 0, y: 53, width: 1440, height: 810 })
  await assert.rejects(
    placeWindow({ client, sessionId: 's' }, { width: 1440, height: 810 }, 1),
    /devicePixelRatio 2; filming needs 1/
  )
})

test('fast-forward spans are cut from the raw recording and retimed', () => {
  const pieces = segments(
    [
      { t0: 2, t1: 5, rate: 4 },
      { t0: 8, t1: null, rate: 2 }
    ],
    0.5
  )
  assert.deepEqual(pieces, [
    { start: 0.5, end: 2.5, rate: 1 },
    { start: 2.5, end: 5.5, rate: 4 },
    { start: 5.5, end: 8.5, rate: 1 },
    { start: 8.5, end: null, rate: 2 }
  ])
  assert.deepEqual(segments([], 0.25), [{ start: 0.25, end: null, rate: 1 }])
  assert.equal(
    screenFilter(segments([{ t0: 1, t1: 2, rate: 3 }], 0)),
    '[0:v]split=3[a0][a1][a2];' +
      '[a0]trim=start=0.0000:end=1.0000,setpts=(PTS-STARTPTS)/1[s0];' +
      '[a1]trim=start=1.0000:end=2.0000,setpts=(PTS-STARTPTS)/3[s1];' +
      '[a2]trim=start=2.0000,setpts=(PTS-STARTPTS)/1[s2];' +
      '[s0][s1][s2]concat=n=3:v=1:a=0,fps=60,format=yuv420p[v]'
  )
})

test('a notification banner fails calibration though the whole-frame mean passes', () => {
  const frame = Uint8Array.from({ length: 160 * 90 }, (_, i) => (i % 160 < 80 ? 30 : 220))
  // A banner in the top right corner: 20x12 probe px, about 1.7% of the frame.
  const banner = frame.map((v, i) => (i % 160 >= 140 && Math.floor(i / 160) < 12 ? 120 : v))
  assert.ok(meanAbsDiff(frame, banner) < CALIBRATION_LIMIT)
  assert.ok(worstTileDiff(frame, banner) > TILE_LIMIT)
  assert.throws(() => checkCalibration(frame, banner), /worst tile/)
})

test('the record lock serializes takes and takes over a dead owner', async () => {
  const lock = path.join(mkdtempSync(path.join(tmpdir(), 'film-lock-')), 'record.lock')
  const release = await takeRecordLock('first', lock)
  let second = false
  const waiting = takeRecordLock('second', lock).then((r) => ((second = true), r))
  await new Promise((done) => setTimeout(done, 100))
  assert.equal(second, false)
  release()
  ;(await waiting)()
  assert.equal(second, true)
  // An owner process that is gone does not hold the lock.
  mkdirSync(lock)
  writeFileSync(path.join(lock, 'owner'), '999999 crashed')
  ;(await takeRecordLock('third', lock))()
  assert.equal(existsSync(lock), false)
})

const STUBBORN = 'process.stdin.resume(); setInterval(() => {}, 1000)'

/**
 * A take dir and the real screen backend with ffmpeg replaced by a child that, like ffmpeg, keeps
 * going after its stdin ends and ignores `q`. With `startFails` the child dies at once and `start`
 * kills it and throws, as it does when no first frame arrives.
 */
function fakeTake(scene, { startFails = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'film-take-'))
  const lock = path.join(dir, 'record.lock')
  writeFileSync(
    path.join(dir, 'narration.json'),
    JSON.stringify({ silent: true, scenes: [{ id: 'one', dur: 0 }] })
  )
  writeFileSync(path.join(dir, 'scenes.mjs'), `export const scenes = { one: ${scene} }`)
  const backend = new ScreenRecorder(null, { lock })
  backend.start = async function (out) {
    this.release = await takeRecordLock('test', this.lock)
    this.raw = path.join(out, 'raw.mkv')
    writeFileSync(this.raw, 'frames')
    const code = startFails ? 'process.exit(1)' : STUBBORN
    this.watch(spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'ignore', 'pipe'] }))
    if (startFails) {
      // The child is dead before this process has handled its exit, as when ffmpeg fails at once.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
      this.ffmpeg.kill('SIGKILL')
      throw new Error('The screen recording did not start: no frame in 10 s')
    }
    return { width: 1440, height: 810, scale: 2 }
  }
  const page = { evaluate: async () => undefined, mouse: { move: async () => undefined } }
  return { dir, lock, backend, page }
}

function assertCleanedUp({ backend, lock }) {
  assert.ok(backend.ffmpeg.exitCode !== null || backend.ffmpeg.signalCode !== null)
  assert.equal(existsSync(backend.raw), false)
  assert.equal(existsSync(lock), false)
}

test('a throwing scene aborts the take: the recording child is killed, its file and the lock are gone', async () => {
  const take = fakeTake("async () => { throw new Error('scene failed') }")
  await assert.rejects(record(take.dir, take), /scene failed/)
  assertCleanedUp(take)
})

test('a failed stop aborts the take', async () => {
  const take = fakeTake('async () => {}')
  take.backend.driverProbe = async () => {
    throw new Error('session gone')
  }
  await assert.rejects(record(take.dir, take), /session gone/)
  assertCleanedUp(take)
})

test('a recording that never starts fails with its own message, not EPIPE', async () => {
  const take = fakeTake('async () => {}', { startFails: true })
  await assert.rejects(record(take.dir, take), /The screen recording did not start/)
  assertCleanedUp(take)
})

const SCREEN_REC = new URL('./screen-rec.mjs', import.meta.url).href

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`${signal} to the filming process kills the recording child and frees the lock`, async () => {
    const lock = path.join(mkdtempSync(path.join(tmpdir(), 'film-signal-')), 'record.lock')
    const script = `
      import { spawn } from 'node:child_process'
      import { ScreenRecorder, takeRecordLock } from ${JSON.stringify(SCREEN_REC)}
      const rec = new ScreenRecorder(null, { lock: ${JSON.stringify(lock)} })
      rec.release = await takeRecordLock('signal', rec.lock)
      rec.watch(spawn(process.execPath, ['-e', ${JSON.stringify(STUBBORN)}], { stdio: ['pipe', 'ignore', 'pipe'] }))
      console.log(rec.ffmpeg.pid)
      setInterval(() => {}, 1000)`
    const node = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'inherit']
    })
    const pid = Number(await new Promise((done) => node.stdout.once('data', done)))
    const ended = new Promise((done) => node.once('exit', (code, sig) => done(sig)))
    node.kill(signal)
    assert.equal(await ended, signal)
    assert.equal(existsSync(lock), false)
    let alive = true
    for (let i = 0; i < 100 && alive; i += 1) {
      try {
        process.kill(pid, 0)
        await new Promise((done) => setTimeout(done, 20))
      } catch {
        alive = false
      }
    }
    assert.equal(alive, false, 'the recording child outlived the filming process')
  })
}

test('a lock with no owner file is taken once it is older than a crash; a parent dir is made', async () => {
  const lock = path.join(mkdtempSync(path.join(tmpdir(), 'film-lock-')), 'missing', 'record.lock')
  ;(await takeRecordLock('first', lock))()
  mkdirSync(lock)
  const old = new Date(Date.now() - 60_000)
  utimesSync(lock, old, old)
  ;(await takeRecordLock('second', lock))()
  assert.equal(existsSync(lock), false)
})

test('an owner the check may not signal (EPERM) holds the lock', async () => {
  const lock = path.join(mkdtempSync(path.join(tmpdir(), 'film-lock-')), 'record.lock')
  mkdirSync(lock)
  // launchd (pid 1) runs as root: signal 0 to it fails with EPERM.
  writeFileSync(path.join(lock, 'owner'), '1 root-take')
  let taken = false
  const waiting = takeRecordLock('second', lock).then((release) => ((taken = true), release))
  await new Promise((done) => setTimeout(done, 100))
  assert.equal(taken, false)
  assert.equal(existsSync(path.join(lock, 'owner')), true)
  rmSync(lock, { recursive: true, force: true })
  ;(await waiting)()
})
