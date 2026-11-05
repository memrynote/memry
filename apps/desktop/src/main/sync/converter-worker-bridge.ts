/**
 * Runs the BlockNote converter's seeds and write-back conversions on the
 * converter worker, and on main when the worker is unavailable.
 *
 * The converter loads BlockNote and jsdom on first use and walks the whole
 * document. On main, the first note open or the first edit after launch
 * blocked the event loop for 12 s and more on Windows after a reboot (cold
 * disk cache, Defender scanning jsdom's files): the window went "Not
 * Responding". On the worker the same wait delays only the note's body or its
 * file write, while the window keeps responding.
 *
 * One worker, spawned on the first job and kept while jobs keep arriving; it
 * exits after an idle period so jsdom's memory is not held for a whole session
 * (#2505). Each job sends the doc as a state update. A seed gets back the
 * update `markdownToYFragment` made to a copy of the doc, and a write-back the
 * result of `convertForWriteback`, the function main runs in the fallback.
 *
 * The fallback is what keeps notes opening and saving when the worker cannot:
 * a build without the worker entry, a spawn the platform refuses, a crash or a
 * job that never answers. Such a job converts on main, as every job did
 * before; after repeated failures the session stops trying the worker.
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { getCalloutTypeDefinitions } from '@memry/editor-schema/callout-types'
import type { WritingFrontmatter } from '@memry/shared/writing-tools/markdown'
import { createLogger } from '../lib/logger'
import { trackMainLog } from '../telemetry/diagnostics'
import { loadBlockNoteConverter } from './blocknote-converter-loader'
import { convertForWriteback, type WritebackConversion } from './writeback-conversion'
import {
  CONVERTER_WORKER_FILE,
  type ConverterJob,
  type ConverterJobResults,
  type FromConverterWorker,
  type ToConverterWorker
} from './converter-worker-protocol'

const log = createLogger('ConverterWorker')

/** Same window the in-process converter keeps its server editor for. */
export const WORKER_IDLE_EXIT_MS = 3 * 60_000
/** Generous: a cold start on a slow machine loads jsdom before the first job converts. */
export const WORKER_TIMEOUT_MS = 120_000
/** Worker failures (crash, refused spawn, timeout) after which the session converts on main. */
export const MAX_WORKER_FAILURES = 3

export type ConvertWriteback = (
  doc: Y.Doc,
  notePath: string,
  readFileBody: () => Promise<string | null>
) => Promise<WritebackConversion>

interface WorkerHandle {
  thread: Worker
  ready: Promise<void>
  markReady: () => void
  failReady: (error: Error) => void
  readyTimer: ReturnType<typeof setTimeout>
}

interface PendingJob {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  readFileBody: (() => Promise<string | null>) | undefined
  timer: ReturnType<typeof setTimeout>
}

let current: WorkerHandle | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let workerFailures = 0
let workerDisabled = false
let nextJobId = 0
const pending = new Map<number, PendingJob>()

/**
 * A converter a write-back pass can start on without loading anything.
 * Awaited before the pass reads its note row, so that row is as fresh as the
 * conversion itself: the load (seconds on a cold start) happens first, as it
 * did on main.
 */
export async function readyWritebackConverter(): Promise<ConvertWriteback> {
  const handle = await readyWorker()
  if (handle) {
    return (doc, notePath, readFileBody) =>
      runJob(handle, { kind: 'writeback', notePath }, doc, readFileBody).catch(
        async (error: unknown) => {
          log.warn('Write-back conversion failed on the worker, converting on main', {
            notePath,
            error
          })
          return convertForWriteback(doc, notePath, readFileBody, await loadBlockNoteConverter())
        }
      )
  }
  const converter = await loadBlockNoteConverter()
  return (doc, notePath, readFileBody) =>
    convertForWriteback(doc, notePath, readFileBody, converter)
}

/**
 * `markdownToYFragment` for the doc's note fragment, run on the worker. The
 * worker seeds a copy of the doc and this applies what the seed added. A
 * fragment that filled while the worker seeded (a remote update, another
 * open) is left alone: applying the seed over it would put the body in twice.
 */
export async function seedFragment(
  markdown: string,
  fragment: Y.XmlFragment,
  notePath: string | undefined,
  writing: WritingFrontmatter | undefined
): Promise<boolean> {
  const doc = fragment.doc
  const handle = fragment === doc?.getXmlFragment(CRDT_FRAGMENT_NAME) ? await readyWorker() : null
  if (doc && handle) {
    try {
      const update = await runJob(handle, { kind: 'seed', markdown, notePath, writing }, doc)
      if (!update) return false
      if (fragment.length > 0) {
        log.info('Seed dropped: the note filled while it was seeding', { notePath })
        return false
      }
      Y.applyUpdate(doc, update)
      return true
    } catch (error) {
      log.warn('Seed failed on the worker, seeding on main', { notePath, error })
    }
  }
  const { markdownToYFragment } = await loadBlockNoteConverter()
  return markdownToYFragment(markdown, fragment, notePath, writing)
}

async function readyWorker(): Promise<WorkerHandle | null> {
  const handle = workerDisabled ? null : startWorker()
  if (!handle) return null
  try {
    await handle.ready
    return handle
  } catch (error) {
    log.warn('Converter worker did not start, converting on main', { error })
    return null
  }
}

function startWorker(): WorkerHandle | null {
  if (current) return current
  const path = join(__dirname, CONVERTER_WORKER_FILE)
  // Missing only in a build that shipped without the rollup entry, which
  // check-worker-bundles fails in CI, and under unit tests, which run sources.
  if (!existsSync(path)) {
    workerDisabled = true
    log.warn('Converter worker entry is missing, converting on main', { path })
    return null
  }
  let thread: Worker
  try {
    thread = new Worker(path)
  } catch (error) {
    recordWorkerFailure(error)
    return null
  }
  const { promise: ready, resolve: markReady, reject: failReady } = Promise.withResolvers<void>()
  // Rejected only through onWorkerGone, and every waiter has a catch for it.
  ready.catch(() => {})
  const readyTimer = setTimeout(() => {
    onWorkerGone(handle, new Error(`not ready in ${WORKER_TIMEOUT_MS} ms`))
  }, WORKER_TIMEOUT_MS)
  readyTimer.unref?.()
  const handle: WorkerHandle = { thread, ready, markReady, failReady, readyTimer }
  thread.on('message', (message: FromConverterWorker) => onWorkerMessage(handle, message))
  thread.on('error', (error: unknown) => onWorkerGone(handle, error))
  thread.on('exit', (code) => {
    onWorkerGone(handle, new Error(`worker exited with code ${code}`))
  })
  current = handle
  return handle
}

function runJob<K extends ConverterJob['kind']>(
  handle: WorkerHandle,
  job: Extract<ConverterJob, { kind: K }>,
  doc: Y.Doc,
  readFileBody?: () => Promise<string | null>
): Promise<ConverterJobResults[K]> {
  if (current !== handle) return Promise.reject(new Error('worker is gone'))
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  const jobId = ++nextJobId
  const update = Y.encodeStateAsUpdate(doc)
  return new Promise<ConverterJobResults[K]>((resolve, reject) => {
    const timer = setTimeout(() => {
      // A job that never answers would hold its note forever; the worker
      // goes with it, and the jobs on it convert on main.
      onWorkerGone(handle, new Error(`no answer in ${WORKER_TIMEOUT_MS} ms`))
    }, WORKER_TIMEOUT_MS)
    timer.unref?.()
    pending.set(jobId, {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the worker answers a job of kind K with ConverterJobResults[K]
      resolve: (result) => resolve(result as ConverterJobResults[K]),
      reject,
      readFileBody,
      timer
    })
    const message: ToConverterWorker = {
      type: 'job',
      jobId,
      job,
      update,
      calloutTypes: getCalloutTypeDefinitions()
    }
    handle.thread.postMessage(message)
  })
}

function settle(jobId: number): PendingJob | undefined {
  const job = pending.get(jobId)
  if (!job) return undefined
  pending.delete(jobId)
  clearTimeout(job.timer)
  if (pending.size === 0) armIdleExit()
  return job
}

function onWorkerMessage(handle: WorkerHandle, message: FromConverterWorker): void {
  switch (message.type) {
    case 'ready':
      clearTimeout(handle.readyTimer)
      handle.markReady()
      if (pending.size === 0) armIdleExit()
      return
    case 'result':
      settle(message.jobId)?.resolve(message.result)
      return
    case 'failed':
      settle(message.jobId)?.reject(new Error(message.message))
      return
    case 'call':
      void answerCall(message)
        .then((value): ToConverterWorker => ({
          type: 'reply',
          callId: message.callId,
          ok: true,
          value
        }))
        .catch((error: unknown): ToConverterWorker => ({
          type: 'reply',
          callId: message.callId,
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        }))
        .then((reply) => {
          if (current === handle) handle.thread.postMessage(reply)
        })
  }
}

async function answerCall(call: Extract<FromConverterWorker, { type: 'call' }>): Promise<unknown> {
  if (call.op === 'readFileBody') {
    const readFileBody = pending.get(call.jobId)?.readFileBody
    if (!readFileBody) throw new Error(`job ${call.jobId} reads no file`)
    return readFileBody()
  }
  // Loaded lazily, as the in-process converter loads it (blocknote-converter-loader.ts).
  const { resolveVaultEmbeds } = await import('../vault/resolve-embed')
  return resolveVaultEmbeds(call.refs, call.notePath)
}

function armIdleExit(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    const idle = current
    if (!idle || pending.size > 0) return
    current = null
    clearTimeout(idle.readyTimer)
    idle.thread.removeAllListeners()
    void idle.thread.terminate()
  }, WORKER_IDLE_EXIT_MS)
  idleTimer.unref?.()
}

function onWorkerGone(gone: WorkerHandle, error: unknown): void {
  if (current !== gone) return
  current = null
  clearTimeout(gone.readyTimer)
  gone.thread.removeAllListeners()
  void gone.thread.terminate()
  const failure = error instanceof Error ? error : new Error(String(error))
  gone.failReady(failure)
  for (const jobId of pending.keys()) settle(jobId)?.reject(failure)
  recordWorkerFailure(failure)
}

function recordWorkerFailure(error: unknown): void {
  workerFailures += 1
  log.warn('Converter worker failed', { failures: workerFailures, error })
  if (workerFailures < MAX_WORKER_FAILURES || workerDisabled) return
  workerDisabled = true
  trackMainLog('warn', {
    scope: 'ConverterWorker',
    action: 'worker_disabled',
    metrics: { retryCount: workerFailures }
  })
}
