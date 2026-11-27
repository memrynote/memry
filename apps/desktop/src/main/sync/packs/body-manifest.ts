import { CrdtManifestResponseSchema, type CrdtManifestDocument } from '@memry/contracts/sync-api'

import { createLogger } from '../../lib/logger'
import { getFromServer, RateLimitError, SyncServerError } from '../http-client'

const log = createLogger('BodyManifest')

/** A page answered 429 is asked again within one window (protocol 08 §8.4.3). */
const RATE_LIMIT_WINDOW_MS = 60_000

export type BodyManifest = ReadonlyMap<string, CrdtManifestDocument>

export interface BodyManifestDeps {
  fetchPage?: (token: string, cursor: string | null) => Promise<unknown>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  signal?: AbortSignal
}

const defaultFetchPage = async (token: string, cursor: string | null): Promise<unknown> =>
  getFromServer<unknown>(
    cursor ? `/sync/crdt/manifest?cursor=${encodeURIComponent(cursor)}` : '/sync/crdt/manifest',
    token
  )

/**
 * A body manifest read (protocol 08 §8.4.3): every page of
 * `GET /sync/crdt/manifest` from no cursor until `nextCursor` is null.
 *
 * - null: a server without the route answered the first page 404. The reader
 *   keeps the snapshot-only rule of a server that predates the manifest.
 * - 'short': the read stopped short on a server that has the route (a
 *   malformed page, a transport failure, a 429 past one window, an abort).
 *   It confirms nothing, and no packed body applies (§8.11).
 */
export const readBodyManifest = async (
  token: string,
  deps: BodyManifestDeps = {}
): Promise<BodyManifest | null | 'short'> => {
  const fetchPage = deps.fetchPage ?? defaultFetchPage
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? (() => Date.now())
  const documents = new Map<string, CrdtManifestDocument>()
  let cursor: string | null = null
  let limitedSince: number | null = null
  for (;;) {
    if (deps.signal?.aborted) return 'short'
    let raw: unknown
    try {
      raw = await fetchPage(token, cursor)
    } catch (error) {
      if (error instanceof RateLimitError) {
        limitedSince ??= now()
        const waitMs = Math.max(1_000, (error.retryAfter ?? 1) * 1_000)
        if (now() + waitMs - limitedSince <= RATE_LIMIT_WINDOW_MS) {
          await sleep(waitMs)
          continue
        }
      }
      if (cursor === null && error instanceof SyncServerError && error.statusCode === 404) {
        return null
      }
      log.info('Body manifest read stopped short — no packed body applies', {
        error: error instanceof Error ? error.message : String(error)
      })
      return 'short'
    }
    limitedSince = null
    const page = CrdtManifestResponseSchema.safeParse(raw)
    if (!page.success) {
      log.info('Body manifest page failed validation — no packed body applies')
      return 'short'
    }
    for (const document of page.data.documents) documents.set(document.noteId, document)
    cursor = page.data.nextCursor
    if (cursor === null) return documents
  }
}
