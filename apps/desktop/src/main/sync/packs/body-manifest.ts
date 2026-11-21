import { CrdtManifestResponseSchema, type CrdtManifestDocument } from '@memry/contracts/sync-api'

import { createLogger } from '../../lib/logger'
import { getFromServer, RateLimitError } from '../http-client'

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
 * `GET /sync/crdt/manifest` from no cursor until `nextCursor` is null. Null
 * when the read stops short for any reason (a server without the route answers
 * 404, a malformed page, a transport failure, a 429 past one window): a read
 * that stopped short answers nothing, so no packed body is confirmed by it.
 */
export const readBodyManifest = async (
  token: string,
  deps: BodyManifestDeps = {}
): Promise<BodyManifest | null> => {
  const fetchPage = deps.fetchPage ?? defaultFetchPage
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? (() => Date.now())
  const documents = new Map<string, CrdtManifestDocument>()
  let cursor: string | null = null
  let limitedSince: number | null = null
  for (;;) {
    if (deps.signal?.aborted) return null
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
      log.info('Body manifest read stopped short — packed bodies stay unconfirmed', {
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
    limitedSince = null
    const page = CrdtManifestResponseSchema.safeParse(raw)
    if (!page.success) {
      log.info('Body manifest page failed validation — packed bodies stay unconfirmed')
      return null
    }
    for (const document of page.data.documents) documents.set(document.noteId, document)
    cursor = page.data.nextCursor
    if (cursor === null) return documents
  }
}
