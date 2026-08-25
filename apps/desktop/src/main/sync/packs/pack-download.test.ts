import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RateLimitError, SyncServerError } from '../http-client'
import { discardPackFile, downloadPackToFile } from './pack-download'

const streamOf = (chunks: Uint8Array[], failAfter?: number): ReadableStream<Uint8Array> => {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== undefined && index === failAfter) {
        controller.error(new Error('socket closed'))
        return
      }
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index++])
    }
  })
}

const responseOf = (
  status: number,
  body: ReadableStream<Uint8Array> | null,
  headers: Record<string, string> = {}
): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    body,
    headers: { get: (name: string) => headers[name] ?? null }
  }) as unknown as Response

describe('downloadPackToFile', () => {
  let dir: string
  let dest: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memry-pack-dl-'))
    dest = path.join(dir, 'p.pack')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('streams a fresh transfer to disk without a Range header', async () => {
    const seen: RequestInit[] = []
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init)
      return responseOf(200, streamOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]))
    })

    const result = await downloadPackToFile({
      url: 'https://r2.example/p.pack',
      destPath: dest,
      fetchFn: fetchFn as unknown as typeof globalThis.fetch
    })

    expect(result).toEqual({ bytes: 5, resumed: false })
    expect(await fs.readFile(dest)).toEqual(Buffer.from([1, 2, 3, 4, 5]))
    expect(seen[0].headers).toEqual({})
  })

  it('resumes an interrupted transfer from the byte offset instead of restarting', async () => {
    const calls: Array<Record<string, string>> = []
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init.headers as Record<string, string>)
      if (calls.length === 1) {
        // Four bytes land, then the socket dies mid-stream.
        return responseOf(200, streamOf([new Uint8Array([1, 2, 3, 4])], 1))
      }
      return responseOf(206, streamOf([new Uint8Array([5, 6])]))
    })

    const result = await downloadPackToFile({
      url: 'https://r2.example/p.pack',
      destPath: dest,
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      sleep: async () => {}
    })

    expect(calls[0]).toEqual({})
    // The retry asked for the REMAINDER, not the whole object again.
    expect(calls[1]).toEqual({ Range: 'bytes=4-' })
    expect(result).toEqual({ bytes: 6, resumed: true })
    expect(await fs.readFile(dest)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]))
  })

  it('restarts cleanly when the server ignores the Range header', async () => {
    await fs.writeFile(dest, Buffer.from([9, 9, 9]))
    const fetchFn = vi.fn(async () =>
      // 200, not 206: the whole object. Appending it would corrupt the pack.
      responseOf(200, streamOf([new Uint8Array([1, 2, 3, 4])]))
    )

    const result = await downloadPackToFile({
      url: 'https://r2.example/p.pack',
      destPath: dest,
      fetchFn: fetchFn as unknown as typeof globalThis.fetch
    })

    expect(result).toEqual({ bytes: 4, resumed: false })
    expect(await fs.readFile(dest)).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('treats 416 on a resume as "already complete"', async () => {
    await fs.writeFile(dest, Buffer.from([1, 2, 3]))
    const fetchFn = vi.fn(async () => responseOf(416, null))

    await expect(
      downloadPackToFile({
        url: 'https://r2.example/p.pack',
        destPath: dest,
        fetchFn: fetchFn as unknown as typeof globalThis.fetch
      })
    ).resolves.toEqual({ bytes: 3, resumed: true })
  })

  it('surfaces 429 as RateLimitError so the caller owns the backoff', async () => {
    const fetchFn = vi.fn(async () => responseOf(429, null, { 'Retry-After': '17' }))
    await expect(
      downloadPackToFile({
        url: 'https://r2.example/p.pack',
        destPath: dest,
        fetchFn: fetchFn as unknown as typeof globalThis.fetch
      })
    ).rejects.toBeInstanceOf(RateLimitError)
  })

  it('surfaces a non-2xx as SyncServerError', async () => {
    const fetchFn = vi.fn(async () => responseOf(403, null))
    await expect(
      downloadPackToFile({
        url: 'https://r2.example/p.pack',
        destPath: dest,
        fetchFn: fetchFn as unknown as typeof globalThis.fetch
      })
    ).rejects.toBeInstanceOf(SyncServerError)
  })

  it('paces every request through the injected hook', async () => {
    const pace = vi.fn(async () => {})
    const fetchFn = vi.fn(async () => responseOf(200, streamOf([new Uint8Array([1])])))
    await downloadPackToFile({
      url: 'https://r2.example/p.pack',
      destPath: dest,
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      pace
    })
    expect(pace).toHaveBeenCalledTimes(1)
  })

  it('removes the temp file on discard', async () => {
    await fs.writeFile(dest, Buffer.from([1]))
    await discardPackFile(dest)
    await expect(fs.stat(dest)).rejects.toThrow()
    // Idempotent: a second discard of a missing file is silent.
    await expect(discardPackFile(dest)).resolves.toBeUndefined()
  })
})
