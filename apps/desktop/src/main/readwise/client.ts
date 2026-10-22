import { z } from 'zod'

import { createLogger } from '../lib/logger'

const logger = createLogger('Readwise:Client')

const READWISE_ORIGIN = 'https://readwise.io'

/**
 * Live API check, 2026-10-22: `/api/v2/export/?ids=` answered 200 for 400 ids
 * (3.6 KB URL) and `400 Bad Request` for 800 ids (7.2 KB URL). 100 ids is
 * about 1 KB, far below that limit and below common proxy limits.
 */
export const EXPORT_IDS_BATCH_SIZE = 100

/** Retries after the first `429`. One more `429` turns into `rate-limited`. */
const MAX_RATE_LIMIT_RETRIES = 3
const DEFAULT_RETRY_AFTER_SECONDS = 60
const MAX_RETRY_AFTER_SECONDS = 120
const REQUEST_TIMEOUT_MS = 30_000

export type ReadwiseErrorCode = 'invalid-token' | 'rate-limited' | 'network' | 'server'

/** Typed failure. Callers map `code` to user text. The message never holds the token. */
export class ReadwiseError extends Error {
  readonly code: ReadwiseErrorCode
  readonly status?: number
  readonly retryAfterSeconds?: number

  constructor(
    code: ReadwiseErrorCode,
    message: string,
    details: { status?: number; retryAfterSeconds?: number; cause?: unknown } = {}
  ) {
    super(message, { cause: details.cause })
    this.name = 'ReadwiseError'
    this.code = code
    this.status = details.status
    this.retryAfterSeconds = details.retryAfterSeconds
  }
}

const HighlightSchema = z.object({
  id: z.number(),
  is_deleted: z.boolean().nullish(),
  text: z.string().nullish(),
  note: z.string().nullish(),
  tags: z.array(z.object({ id: z.number().nullish(), name: z.string() })).nullish(),
  color: z.string().nullish(),
  location: z.number().nullish(),
  location_type: z.string().nullish(),
  end_location: z.number().nullish(),
  highlighted_at: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  is_favorite: z.boolean().nullish(),
  is_discard: z.boolean().nullish(),
  url: z.string().nullish(),
  readwise_url: z.string().nullish(),
  external_id: z.string().nullish()
})

const BookSchema = z.object({
  user_book_id: z.number(),
  is_deleted: z.boolean().nullish(),
  title: z.string().nullish(),
  readable_title: z.string().nullish(),
  author: z.string().nullish(),
  category: z.string().nullish(),
  source: z.string().nullish(),
  source_url: z.string().nullish(),
  unique_url: z.string().nullish(),
  readwise_url: z.string().nullish(),
  cover_image_url: z.string().nullish(),
  book_tags: z.array(z.object({ id: z.number().nullish(), name: z.string() })).nullish(),
  document_note: z.string().nullish(),
  summary: z.string().nullish(),
  external_id: z.string().nullish(),
  asin: z.string().nullish(),
  highlights: z.array(HighlightSchema)
})

const ExportPageSchema = z.object({
  nextPageCursor: z.string().nullish(),
  results: z.array(BookSchema)
})

export type ReadwiseHighlight = z.infer<typeof HighlightSchema>
export type ReadwiseBook = z.infer<typeof BookSchema>

export interface ReadwiseRequestOptions {
  token: string
  /** Aborts the request and any `Retry-After` wait. */
  signal?: AbortSignal
  /** Path under readwise.io, such as `/api/v2/export/`. The token never goes to another host. */
  path: string
  query?: Record<string, string | undefined>
}

function parseRetryAfterSeconds(header: string | null): number {
  const seconds = header === null ? NaN : Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_AFTER_SECONDS
  return Math.min(Math.ceil(seconds), MAX_RETRY_AFTER_SECONDS)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      try {
        signal?.throwIfAborted()
      } catch (reason) {
        reject(reason as Error)
      }
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

function buildUrl(path: string, query: ReadwiseRequestOptions['query']): string {
  const url = new URL(path, READWISE_ORIGIN)
  if (url.origin !== READWISE_ORIGIN) {
    throw new Error('Readwise requests must stay on readwise.io')
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

/**
 * The one HTTP entry point to Readwise, shared with the Reader client (#1419).
 * It owns the auth header, the `429` backoff, and abort. GET only: the client
 * is read-only by construction.
 *
 * Resolves with a 2xx response. Throws `ReadwiseError` for everything else and
 * rethrows the signal's reason when `signal` aborts.
 */
export async function readwiseGet(options: ReadwiseRequestOptions): Promise<Response> {
  const { token, signal, path, query } = options
  const url = buildUrl(path, query)

  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()

    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Token ${token}` },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      logger.warn('Readwise request failed', { path, error: (error as Error).name })
      throw new ReadwiseError('network', 'Could not reach Readwise', { cause: error })
    }

    if (response.ok) return response

    const { status } = response
    if (status === 401 || status === 403) {
      throw new ReadwiseError('invalid-token', 'Readwise rejected the access token', { status })
    }
    if (status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('Retry-After'))
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw new ReadwiseError('rate-limited', 'Readwise rate limit reached', {
          status,
          retryAfterSeconds
        })
      }
      logger.info('Readwise rate limited, waiting', { path, retryAfterSeconds })
      await sleep(retryAfterSeconds * 1000, signal)
      continue
    }
    throw new ReadwiseError('server', `Readwise answered ${status}`, { status })
  }
}

/** `GET /api/v2/auth/`: 204 means the token is valid. */
export async function verifyToken(token: string, signal?: AbortSignal): Promise<void> {
  await readwiseGet({ token, signal, path: '/api/v2/auth/' })
}

async function* exportPagesFor(
  token: string,
  query: Record<string, string | undefined>,
  signal: AbortSignal | undefined
): AsyncGenerator<ReadwiseBook[]> {
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const response = await readwiseGet({
      token,
      signal,
      path: '/api/v2/export/',
      query: { ...query, pageCursor: cursor }
    })
    const parsed = ExportPageSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      throw new ReadwiseError('server', 'Readwise sent an export page in an unknown shape')
    }
    yield parsed.data.results
    cursor = parsed.data.nextPageCursor ?? undefined
    if (cursor !== undefined) {
      if (seen.has(cursor)) {
        throw new ReadwiseError('server', 'Readwise repeated a page cursor')
      }
      seen.add(cursor)
    }
  } while (cursor !== undefined)
}

export interface ExportPagesOptions {
  token: string
  /** Only highlights updated after this ISO 8601 date, grouped by book (D7). */
  updatedAfter?: string
  includeDeleted: boolean
  signal?: AbortSignal
}

/**
 * Every page of `GET /api/v2/export/`, one array of books per page. Pagination
 * through `nextPageCursor` stays inside.
 */
export function exportPages(options: ExportPagesOptions): AsyncGenerator<ReadwiseBook[]> {
  return exportPagesFor(
    options.token,
    {
      updatedAfter: options.updatedAfter,
      includeDeleted: options.includeDeleted ? 'true' : undefined
    },
    options.signal
  )
}

export interface ExportBooksOptions {
  token: string
  /** `user_book_id`s. */
  ids: readonly number[]
  signal?: AbortSignal
}

/**
 * Full books, with every highlight, in batches of `EXPORT_IDS_BATCH_SIZE`.
 * `ids` is the only way to get a book's full highlight list (D7, D16).
 */
export async function* exportBooks(options: ExportBooksOptions): AsyncGenerator<ReadwiseBook[]> {
  const ids = [...new Set(options.ids)]
  for (let start = 0; start < ids.length; start += EXPORT_IDS_BATCH_SIZE) {
    const batch = ids.slice(start, start + EXPORT_IDS_BATCH_SIZE)
    yield* exportPagesFor(options.token, { ids: batch.join(',') }, options.signal)
  }
}
