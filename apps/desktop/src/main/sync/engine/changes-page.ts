import type { RecordChangesResponse, RecordPullItemResponse } from '@memry/contracts/sync-api'
import { withRetry } from '@memry/sync-client/retry'
import { engineAuthRetryDeps, withAuthRetry } from '../auth-retry'
import { postToServer } from '../http-client'
import { PULL_REQUEST_MAX_IDS, type SyncContext } from './sync-context'
import type { PageNoteBodies } from './note-body-feed'

/**
 * One decrypt + apply unit of a `/sync/changes` page: at most one POST
 * /sync/pull, plus, on the first slice only, the items the page carried
 * inline (#2292). Inline and pulled items share the slice's one page
 * transaction and one apply-order sort (protocol 05 §5.13).
 */
export interface PullSlice {
  /** At most PULL_REQUEST_MAX_IDS ids still fetched with POST /sync/pull. Empty when the page arrived inline. */
  fetchIds: string[]
  /** Raw `/sync/pull` items from `changes.inline`; parsePullItems validates each one (§5.14). */
  inline: unknown[]
  /** The page's note bodies (#2297), on the last slice only: the cursor waits for that slice. */
  noteBodies?: PageNoteBodies
}

/**
 * Plans how a changes page is fetched. Page ids are the distinct `items` ids
 * then `deleted` ids, in page order. An id named by an inline element is
 * covered: the server inlines by id, never one type of an id without the
 * others (protocol 05 §5.11.2). Uncovered ids are chunked for POST /sync/pull.
 * A page without an `inline` array (old server, or not asked) plans exactly
 * the pre-inline slices.
 */
export function planPullSlices(changes: RecordChangesResponse): PullSlice[] {
  const pageIds = new Set([...changes.items.map((item) => item.id), ...changes.deleted])
  const inline: unknown[] = Array.isArray(changes.inline) ? changes.inline : []
  const covered = new Set(
    inline.map((raw) => (raw as { id?: unknown } | null)?.id).filter((id) => typeof id === 'string')
  )
  const fetchIds = Array.from(pageIds).filter((id) => !covered.has(id))

  const slices: PullSlice[] = []
  for (let i = 0; i < fetchIds.length; i += PULL_REQUEST_MAX_IDS) {
    slices.push({ fetchIds: fetchIds.slice(i, i + PULL_REQUEST_MAX_IDS), inline: [] })
  }
  if (inline.length === 0) return slices
  if (slices.length === 0) return [{ fetchIds: [], inline }]
  slices[0].inline = inline
  return slices
}

/**
 * The raw POST /sync/pull body for a slice's `fetchIds`, or an empty envelope
 * without a request when the whole slice arrived inline. `session.accessJwt`
 * is replaced when a 401 forces a token refresh.
 */
export async function fetchSliceBody(
  ctx: SyncContext,
  session: { accessJwt: string },
  fetchIds: string[]
): Promise<unknown> {
  if (fetchIds.length === 0) return { items: [] }
  const result = await withRetry(
    () =>
      withAuthRetry(
        (authToken) =>
          postToServer<{ items: RecordPullItemResponse[] }>(
            '/sync/pull',
            { itemIds: fetchIds },
            authToken
          ),
        session.accessJwt,
        engineAuthRetryDeps(ctx.deps),
        (fresh) => {
          session.accessJwt = fresh
        }
      ),
    { signal: ctx.abortController!.signal, isOnline: () => ctx.deps.network.online }
  )
  return result.value
}
