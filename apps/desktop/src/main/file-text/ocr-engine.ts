/**
 * The OCR utility process (ocr-worker.ts): one Tesseract worker at low OS
 * priority, started on the first request and stopped after a minute of quiet.
 * English data ships in out/main/tessdata; nothing is fetched.
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'fs'
import path from 'path'
import { createLogger } from '../lib/logger'
import { getLogShip } from '../telemetry/log-ship'
import { lowerProcessPriority } from './low-priority'
import type { OcrImageSource, OcrMainToWorkerMessage, OcrWorkerToMainMessage } from './ocr-protocol'

const logger = createLogger('Ocr')

const START_TIMEOUT_MS = 15_000
const RECOGNIZE_TIMEOUT_MS = 180_000
const IDLE_SHUTDOWN_MS = 60_000

interface Pending {
  resolve: (text: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let worker: Promise<UtilityProcess> | null = null
let child: UtilityProcess | null = null
const pending = new Map<number, Pending>()
let nextRequestId = 1
let idleTimer: ReturnType<typeof setTimeout> | null = null
let reportedMissingData = false

/** asar-unpacked in a packaged build: Tesseract's own thread reads it with plain fs. */
function languageDataDir(): string {
  return path.join(__dirname, 'tessdata').replace('app.asar', 'app.asar.unpacked')
}

/**
 * Without its language data Tesseract does not fail; the request waits out
 * RECOGNIZE_TIMEOUT_MS. Fail at once instead, and log it once per run.
 */
function assertLanguageData(): void {
  if (existsSync(path.join(languageDataDir(), 'eng.traineddata.gz'))) return
  if (!reportedMissingData) {
    reportedMissingData = true
    logger.error('OCR language data is missing; scanned pages and images stay unread')
  }
  throw new Error('OCR language data is missing')
}

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

/** Kill the utility process and fail whatever it was working on. */
export function stopOcr(reason = 'OCR stopped'): void {
  clearIdleTimer()
  const stopping = child
  child = null
  worker = null
  for (const request of pending.values()) {
    clearTimeout(request.timer)
    request.reject(new Error(reason))
  }
  pending.clear()
  stopping?.kill()
}

function settle(requestId: number, outcome: (request: Pending) => void): void {
  const request = pending.get(requestId)
  if (!request) return
  pending.delete(requestId)
  clearTimeout(request.timer)
  outcome(request)
  if (pending.size === 0) {
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      child?.postMessage({ type: 'shutdown' } satisfies OcrMainToWorkerMessage)
      child = null
      worker = null
    }, IDLE_SHUTDOWN_MS)
  }
}

function startWorker(): Promise<UtilityProcess> {
  return new Promise((resolve, reject) => {
    const spawned = utilityProcess.fork(path.join(__dirname, 'ocr-worker.js'), [], {
      serviceName: 'MemryOCR',
      env: { ...process.env, MEMRY_OCR_LANG_PATH: languageDataDir() }
    })
    child = spawned
    const startTimer = setTimeout(() => {
      reject(new Error('OCR worker did not start in time'))
      if (child === spawned) stopOcr('OCR worker did not start in time')
    }, START_TIMEOUT_MS)

    spawned.once('spawn', () => lowerProcessPriority(spawned.pid))
    spawned.on('message', (message: OcrWorkerToMainMessage) => {
      switch (message.type) {
        case 'ready':
          clearTimeout(startTimer)
          resolve(spawned)
          return
        case 'log':
          getLogShip()?.ingestForwarded(message.record, 'Ocr')
          return
        case 'recognized':
          settle(message.requestId, (request) => request.resolve(message.text))
          return
        case 'failed':
          settle(message.requestId, (request) => request.reject(new Error(message.error)))
          return
      }
    })
    spawned.once('exit', (code) => {
      clearTimeout(startTimer)
      reject(new Error(`OCR worker exited before it was ready (code ${code})`))
      if (child === spawned) {
        logger.warn('OCR worker exited', { code })
        stopOcr(`OCR worker exited (code ${code})`)
      }
    })
  })
}

/** The text Tesseract reads in `source`. One request at a time is the expected use. */
export async function recognizeText(source: OcrImageSource): Promise<string> {
  assertLanguageData()
  clearIdleTimer()
  worker ??= startWorker().catch((error: unknown) => {
    worker = null
    throw error
  })
  const ready = await worker
  const requestId = nextRequestId++
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      settle(requestId, (request) => request.reject(new Error('OCR did not finish in time')))
      if (child === ready) stopOcr('OCR did not finish in time')
    }, RECOGNIZE_TIMEOUT_MS)
    pending.set(requestId, { resolve, reject, timer })
    ready.postMessage({ type: 'recognize', requestId, source } satisfies OcrMainToWorkerMessage)
  })
}
