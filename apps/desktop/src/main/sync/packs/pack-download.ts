import { promises as fs } from 'node:fs'

import { createLogger } from '../../lib/logger'
import {
  NetworkError,
  RateLimitError,
  SyncServerError,
  parseRetryAfterHeader,
  type FetchFn
} from '../http-client'

const log = createLogger('PackDownload')

/**
 * Transport for one pack file (#1840).
 *
 * Packs are large immutable objects fetched from a presigned R2 URL, so this
 * borrows the attachment transfer discipline rather than inventing a second
 * one: no auth headers on a presigned GET (the signature IS the authorization,
 * and R2 only signs `host`), 429 surfaced as RateLimitError so the caller's
 * pacing owns the backoff, transport failures surfaced as NetworkError.
 *
 * Two properties matter and are tested:
 *   - RESUMABLE. A partial temp file is resumed with `Range: bytes=<have>-`
 *     rather than restarted, so a dropped bootstrap does not re-download the
 *     vault. A server that ignores the Range (answers 200) restarts cleanly.
 *   - STREAMED. Body chunks go straight to the file handle; a pack is never
 *     materialized as one buffer in the main process.
 */

const DEFAULT_MAX_ATTEMPTS = 4
const BASE_RETRY_DELAY_MS = 500

export interface PackDownloadOptions {
  url: string
  /** Temp file to fill. An existing partial file is resumed, never clobbered. */
  destPath: string
  fetchFn?: FetchFn
  signal?: AbortSignal
  /** Rate pacing hook, awaited before every request (bootstrap pacer). */
  pace?: () => Promise<void>
  maxAttempts?: number
  /** Called with each chunk's byte count — throughput telemetry. */
  onBytes?: (byteCount: number) => void
  /** Injected for tests; production waits on a real timer. */
  sleep?: (ms: number) => Promise<void>
}

export interface PackDownloadResult {
  bytes: number
  /** True when the transfer continued a partial file instead of restarting. */
  resumed: boolean
}

const fileSize = async (filePath: string): Promise<number> => {
  try {
    return (await fs.stat(filePath)).size
  } catch {
    return 0
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A presigned R2 URL carries its own authorization in the query string, so it
 * is a bearer credential and must never reach a log file. `fetch` failures
 * routinely quote the request URL in their message, and these errors are
 * logged verbatim by the bootstrap caller — so the URL is stripped at the
 * point the message is built, not at every log site.
 */
const redactUrls = (message: string): string => message.replace(/https?:\/\/\S+/gi, '<url>')

/** Node's web ReadableStream is async-iterable; undici bodies are too. */
async function* iterateBody(body: unknown): AsyncGenerator<Uint8Array> {
  if (!body) throw new NetworkError('pack response had no body')
  const iterable = body as AsyncIterable<Uint8Array>
  if (typeof iterable[Symbol.asyncIterator] === 'function') {
    for await (const chunk of iterable) yield chunk
    return
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Download one pack to `destPath`, resuming a partial file when one exists.
 * Returns the final byte count. Never holds the pack in memory.
 */
export const downloadPackToFile = async (
  options: PackDownloadOptions
): Promise<PackDownloadResult> => {
  const fetchImpl =
    options.fetchFn ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args))
  const sleep = options.sleep ?? defaultSleep
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)

  let resumed = false
  let lastNetworkError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) throw new NetworkError('pack download aborted')
    await options.pace?.()

    const have = await fileSize(options.destPath)
    const headers: Record<string, string> = {}
    if (have > 0) headers['Range'] = `bytes=${have}-`

    let response: Response
    try {
      response = await fetchImpl(options.url, {
        method: 'GET',
        headers,
        ...(options.signal ? { signal: options.signal } : {})
      })
    } catch (err) {
      lastNetworkError = new NetworkError(`pack fetch failed: ${redactUrls(String(err))}`)
      if (attempt === maxAttempts) throw lastNetworkError
      await sleep(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1))
      continue
    }

    if (response.status === 429) {
      throw new RateLimitError(parseRetryAfterHeader(response.headers.get('Retry-After')))
    }
    if (response.status === 416) {
      // The file is already complete as far as the server is concerned: asking
      // for bytes past the end is how a finished transfer answers a resume.
      return { bytes: have, resumed: true }
    }
    if (!response.ok) {
      throw new SyncServerError(`pack fetch returned ${response.status}`, response.status)
    }

    // A server that ignored the Range header answers 200 with the WHOLE object;
    // appending it to the partial file would corrupt the pack, so restart.
    const appending = have > 0 && response.status === 206
    if (appending) resumed = true

    const handle = await fs.open(options.destPath, appending ? 'a' : 'w')
    let written = appending ? have : 0
    try {
      for await (const chunk of iterateBody(response.body)) {
        if (options.signal?.aborted) throw new NetworkError('pack download aborted')
        await handle.write(chunk)
        written += chunk.byteLength
        options.onBytes?.(chunk.byteLength)
      }
    } catch (err) {
      await handle.close().catch(() => {
        /* the stream failure is the interesting one */
      })
      if (err instanceof NetworkError && options.signal?.aborted) throw err
      lastNetworkError = err instanceof Error ? err : new Error(String(err))
      if (attempt === maxAttempts) {
        throw new NetworkError(`pack transfer interrupted: ${redactUrls(lastNetworkError.message)}`)
      }
      log.info('pack transfer interrupted — resuming from byte offset', {
        attempt,
        haveBytes: await fileSize(options.destPath)
      })
      await sleep(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1))
      continue
    }
    await handle.close()

    return { bytes: written, resumed }
  }

  throw lastNetworkError ?? new NetworkError('pack download failed')
}

/** Best-effort temp cleanup. Success, failure and abort all pass through here. */
export const discardPackFile = async (filePath: string): Promise<void> => {
  try {
    await fs.rm(filePath, { force: true })
  } catch (err) {
    log.debug('Could not remove a pack temp file', { error: err })
  }
}
