import { z } from 'zod'

import { createLogger } from '../lib/logger'
import { readwisePages, sleep } from './client'

const logger = createLogger('Readwise:Reader')

/**
 * The locations Reader sync reads (D11). `feed` holds RSS and newsletter items
 * the user never saved, and is never requested.
 */
export const READER_LOCATIONS = ['new', 'later', 'shortlist', 'archive'] as const
export type ReaderLocation = (typeof READER_LOCATIONS)[number]

/** `limit` is at most 100 on `/api/v3/list/`. */
export const READER_PAGE_SIZE = 100

/** The v3 list allows 20 requests per minute per token. The v2 export allows 240. */
export const READER_REQUESTS_PER_MINUTE = 20
const WINDOW_MS = 60_000

/**
 * Verified against Kaan's account on 2026-10-22 (articles in `new` and
 * `archive`, none in `later` or `shortlist`, no highlights): `tags` is an
 * object keyed by tag name, `notes` and `summary` are strings, `parent_id` is
 * null on a top-level document, `published_date` is a `YYYY-MM-DD` string, and
 * `html_content` appears only with `withHtmlContent=true`. A document with
 * `parent_id` set was not available to check.
 */
const DocumentSchema = z.object({
  id: z.string(),
  url: z.string().nullish(),
  title: z.string().nullish(),
  author: z.string().nullish(),
  source: z.string().nullish(),
  category: z.string().nullish(),
  location: z.string().nullish(),
  tags: z.record(z.string(), z.object({ name: z.string().nullish() }).loose()).nullish(),
  site_name: z.string().nullish(),
  word_count: z.number().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  published_date: z.union([z.string(), z.number()]).nullish(),
  summary: z.string().nullish(),
  image_url: z.string().nullish(),
  source_url: z.string().nullish(),
  notes: z.string().nullish(),
  parent_id: z.string().nullish(),
  html_content: z.string().nullish()
})

const ListPageSchema = z.object({
  nextPageCursor: z.string().nullish(),
  results: z.array(DocumentSchema)
})

export type ReaderDocument = z.infer<typeof DocumentSchema>

/** A sliding-window budget: at most `limit` acquisitions in any `windowMs`. */
export class RequestLimiter {
  private readonly stamps: number[] = []
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  /** Resolves when a request may go out. Rejects with the signal's reason on abort. */
  acquire(signal?: AbortSignal): Promise<void> {
    const turn = this.queue.then(() => this.take(signal))
    this.queue = turn.catch(() => undefined)
    return turn
  }

  private async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted()
      const now = Date.now()
      while (this.stamps.length > 0 && now - this.stamps[0] >= this.windowMs) this.stamps.shift()
      if (this.stamps.length < this.limit) {
        this.stamps.push(now)
        return
      }
      await sleep(this.stamps[0] + this.windowMs - now, signal)
    }
  }
}

/** One budget per process: a vault holds one token, and the budget belongs to the token. */
const sharedLimiter = new RequestLimiter(READER_REQUESTS_PER_MINUTE, WINDOW_MS)

export interface ListDocumentsOptions {
  token: string
  /** Only documents updated after this ISO 8601 date (#1411 keeps the cursor). */
  updatedAfter?: string
  /** Request the article HTML. Only when the full-text toggle is on (#1420). */
  withHtmlContent: boolean
  signal?: AbortSignal
  limiter?: RequestLimiter
}

/**
 * Top-level Reader documents of `new`, `later`, `shortlist`, and `archive`, one
 * array per page. Highlights and notes made in Reader are documents too, with
 * `parent_id` set, and never come out: their text arrives through the v2
 * export (D11). There is no deletion signal, so a document that left Reader
 * simply stops appearing.
 */
export async function* listDocuments(
  options: ListDocumentsOptions
): AsyncGenerator<ReaderDocument[]> {
  const throttle = (signal?: AbortSignal): Promise<void> =>
    (options.limiter ?? sharedLimiter).acquire(signal)

  for (const location of READER_LOCATIONS) {
    for await (const page of readwisePages({
      token: options.token,
      signal: options.signal,
      throttle,
      path: '/api/v3/list/',
      query: {
        location,
        updatedAfter: options.updatedAfter,
        limit: String(READER_PAGE_SIZE),
        withHtmlContent: options.withHtmlContent ? 'true' : undefined
      },
      schema: ListPageSchema
    })) {
      const documents = page.results.filter(
        (document) => document.parent_id == null && document.location !== 'feed'
      )
      if (documents.length < page.results.length) {
        logger.debug('Skipped Reader child or feed documents', {
          count: page.results.length - documents.length
        })
      }
      yield documents
    }
  }
}

export interface GetDocumentOptions {
  token: string
  id: string
  withHtmlContent: boolean
  signal?: AbortSignal
  limiter?: RequestLimiter
}

/**
 * One top-level Reader document by id, or null when Reader no longer has it
 * (or the id names a child or a `feed` item). For a command the user starts
 * on one document (D16); sync reads through `listDocuments`.
 */
export async function getDocument(options: GetDocumentOptions): Promise<ReaderDocument | null> {
  for await (const page of readwisePages({
    token: options.token,
    signal: options.signal,
    throttle: (signal) => (options.limiter ?? sharedLimiter).acquire(signal),
    path: '/api/v3/list/',
    query: { id: options.id, withHtmlContent: options.withHtmlContent ? 'true' : undefined },
    schema: ListPageSchema
  })) {
    const document = page.results.find((row) => row.id === options.id)
    if (document)
      return document.parent_id == null && document.location !== 'feed' ? document : null
  }
  return null
}
