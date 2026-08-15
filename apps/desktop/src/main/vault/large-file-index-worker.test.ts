import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IndexWorkerMessage } from './large-file-index-worker-protocol'

const mocks = vi.hoisted(() => ({
  posted: [] as IndexWorkerMessage[],
  workerData: {} as unknown
}))

vi.mock('worker_threads', () => ({
  parentPort: {
    postMessage: (message: IndexWorkerMessage) => mocks.posted.push(message)
  },
  // A getter: the module reads `workerData` at import time, and each test
  // re-imports with a different file.
  get workerData() {
    return mocks.workerData
  }
}))

/** Import the worker entry, which runs its scan as a side effect of loading. */
async function runWorker(input: unknown): Promise<void> {
  mocks.posted = []
  mocks.workerData = input
  vi.resetModules()
  await import('./large-file-index-worker')
}

describe('large-file index worker', () => {
  beforeEach(() => {
    mocks.posted = []
  })

  it('posts the finished index back to the bridge', async () => {
    // #given a real file the worker has to open itself — a thread cannot
    // inherit the session's handle, so this is the one place the path is
    // resolved a second time
    const dir = await mkdtemp(join(tmpdir(), 'memry-large-file-worker-'))
    const path = join(dir, 'log.md')
    const body = Array.from({ length: 500 }, (_, i) => `row ${i}`).join('\n') + '\n'
    await writeFile(path, body)

    try {
      // #when
      await runWorker({ absolutePath: path, fileBytes: body.length })
      await vi.waitFor(() => expect(mocks.posted.at(-1)?.type).toBe('done'))

      // #then — the shape the bridge unpacks. A protocol drift here degrades
      // silently into the in-process fallback for the life of the build.
      const done = mocks.posted.at(-1)
      expect(done).toMatchObject({ type: 'done', stride: expect.any(Number), lineCount: 500 })
      expect(done && 'checkpoints' in done && done.checkpoints).toBeInstanceOf(Float64Array)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('posts an error rather than dying silently', async () => {
    // #given a file that is not there
    const dir = await mkdtemp(join(tmpdir(), 'memry-large-file-worker-'))

    try {
      // #when
      await runWorker({ absolutePath: join(dir, 'gone.md'), fileBytes: 10 })
      await vi.waitFor(() => expect(mocks.posted.at(-1)?.type).toBe('error'))

      // #then — an unhandled rejection would leave the bridge waiting on a
      // thread that has already given up, and the viewer waiting on the bridge
      expect(mocks.posted.at(-1)).toMatchObject({ type: 'error', message: expect.any(String) })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
