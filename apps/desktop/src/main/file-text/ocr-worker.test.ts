import { afterAll, describe, expect, it, vi } from 'vitest'
import type { OcrImageSource, OcrWorkerToMainMessage } from './ocr-protocol'

/**
 * The worker is a utility-process script: it reads `process.parentPort` and
 * installs process handlers when it loads, so the port has to exist first.
 */
const port = vi.hoisted(() => {
  const fake = {
    posted: [] as unknown[],
    listener: null as null | ((event: { data: unknown }) => void),
    postMessage(message: unknown) {
      fake.posted.push(message)
    },
    on(_event: string, listener: (event: { data: unknown }) => void) {
      fake.listener = listener
    },
    exceptionListeners: process.listeners('uncaughtException'),
    rejectionListeners: process.listeners('unhandledRejection')
  }
  Object.assign(process, { parentPort: fake })
  process.env.MEMRY_OCR_LANG_PATH = '/app/tessdata'
  return fake
})

const reads = vi.hoisted(() => ({ langPath: undefined as string | undefined }))

vi.mock('./ocr-reader', () => ({
  createOcrReader: (langPath: string | undefined) => {
    reads.langPath = langPath
    return {
      read: async (source: OcrImageSource) => {
        if (source.kind === 'file' && source.path.endsWith('.txt')) {
          throw new Error('Input file contains unsupported image format')
        }
        return 'Heron count'
      }
    }
  }
}))

import './ocr-worker'

function send(data: unknown): void {
  port.listener?.({ data })
}

async function replyTo(requestId: number): Promise<OcrWorkerToMainMessage> {
  await vi.waitFor(() => expect(port.posted).toContainEqual(expect.objectContaining({ requestId })))
  return port.posted.find(
    (message) => (message as { requestId?: number }).requestId === requestId
  ) as OcrWorkerToMainMessage
}

describe('OCR worker', () => {
  afterAll(() => {
    for (const listener of process.listeners('uncaughtException')) {
      if (!port.exceptionListeners.includes(listener)) {
        process.off('uncaughtException', listener)
      }
    }
    for (const listener of process.listeners('unhandledRejection')) {
      if (!port.rejectionListeners.includes(listener)) {
        process.off('unhandledRejection', listener)
      }
    }
    Reflect.deleteProperty(process, 'parentPort')
  })

  it('says it is ready, with the language data path it was started with', () => {
    expect(port.posted[0]).toEqual({ type: 'ready' })
    expect(reads.langPath).toBe('/app/tessdata')
  })

  it('answers a request with the text read, or with the reason it failed', async () => {
    send({ type: 'recognize', requestId: 1, source: { kind: 'file', path: '/vault/a.png' } })
    send({ type: 'recognize', requestId: 2, source: { kind: 'file', path: '/vault/b.txt' } })

    await expect(replyTo(1)).resolves.toEqual({
      type: 'recognized',
      requestId: 1,
      text: 'Heron count'
    })
    await expect(replyTo(2)).resolves.toEqual({
      type: 'failed',
      requestId: 2,
      error: 'Input file contains unsupported image format'
    })
  })
})
