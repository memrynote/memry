import { EventEmitter } from 'events'
import * as fs from 'fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OcrMainToWorkerMessage, OcrWorkerToMainMessage } from './ocr-protocol'

/**
 * Stands in for the OCR utility process. It reports ready on spawn and answers
 * each request with `answer`, which a test swaps to make the worker hang,
 * fail, or exit.
 */
class FakeWorker extends EventEmitter {
  pid = 0
  killed = false
  posted: OcrMainToWorkerMessage[] = []
  answer: (message: Extract<OcrMainToWorkerMessage, { type: 'recognize' }>) => void = (message) =>
    this.reply({ type: 'recognized', requestId: message.requestId, text: 'Heron count' })

  postMessage(message: OcrMainToWorkerMessage): void {
    this.posted.push(message)
    if (message.type === 'recognize') this.answer(message)
  }

  reply(message: OcrWorkerToMainMessage): void {
    queueMicrotask(() => this.emit('message', message))
  }

  kill(): void {
    this.killed = true
    this.emit('exit', 1)
  }
}

const workers = vi.hoisted(() => [] as FakeWorker[])
const forkOptions = vi.hoisted(() => [] as Array<{ env?: Record<string, string> }>)

vi.mock('electron', () => ({
  utilityProcess: {
    fork: (_path: string, _args: string[], options: { env?: Record<string, string> }) => {
      const worker = new FakeWorker()
      workers.push(worker)
      forkOptions.push(options)
      worker.reply({ type: 'ready' })
      return worker
    }
  }
}))

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }))
vi.mock('../lib/logger', () => ({ createLogger: () => log }))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, existsSync: vi.fn(actual.existsSync) }
})

import { recognizeText, stopOcr } from './ocr-engine'

const source = { kind: 'file', path: '/vault/scan.png' } as const

describe('OCR engine', () => {
  afterEach(() => {
    stopOcr()
    workers.length = 0
    forkOptions.length = 0
    vi.useRealTimers()
  })

  it('answers with the text the worker read, from one worker for every request', async () => {
    await expect(recognizeText(source)).resolves.toBe('Heron count')
    await expect(recognizeText({ kind: 'png', data: Uint8Array.of(1) })).resolves.toBe(
      'Heron count'
    )

    expect(workers).toHaveLength(1)
    expect(forkOptions[0].env?.MEMRY_OCR_LANG_PATH).toMatch(/tessdata$/)
  })

  it('fails at once, and says so once, when the language data is missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false).mockReturnValueOnce(false)

    await expect(recognizeText(source)).rejects.toThrow('OCR language data is missing')
    await expect(recognizeText(source)).rejects.toThrow('OCR language data is missing')

    expect(workers).toHaveLength(0)
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  it('fails the request when the worker reports an error', async () => {
    await recognizeText(source)
    workers[0].answer = (message) =>
      workers[0].reply({ type: 'failed', requestId: message.requestId, error: 'bad image' })

    await expect(recognizeText(source)).rejects.toThrow('bad image')
  })

  it('fails the request in flight when the worker exits, and starts a new worker next time', async () => {
    await recognizeText(source)
    workers[0].answer = () => workers[0].kill()

    await expect(recognizeText(source)).rejects.toThrow('OCR worker exited (code 1)')
    await expect(recognizeText(source)).resolves.toBe('Heron count')
    expect(workers).toHaveLength(2)
  })

  it('kills a worker that takes longer than three minutes on one image', async () => {
    vi.useFakeTimers()
    await recognizeText(source)
    workers[0].answer = () => {}

    const stuck = recognizeText(source)
    const outcome = expect(stuck).rejects.toThrow('OCR did not finish in time')
    await vi.advanceTimersByTimeAsync(180_000)

    await outcome
    expect(workers[0].killed).toBe(true)
  })

  it('shuts the worker down after a minute without work', async () => {
    vi.useFakeTimers()
    await recognizeText(source)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(workers[0].posted.at(-1)).toEqual({ type: 'shutdown' })
    await expect(recognizeText(source)).resolves.toBe('Heron count')
    expect(workers).toHaveLength(2)
  })

  it('fails the request in flight when OCR is stopped', async () => {
    await recognizeText(source)
    workers[0].answer = () => {}

    const pending = recognizeText(source)
    await vi.waitFor(() => expect(workers[0].posted).toHaveLength(2))
    stopOcr()

    await expect(pending).rejects.toThrow('OCR stopped')
    expect(workers[0].killed).toBe(true)
  })
})
