/**
 * A request, carried in a tab's `viewState`, to open a note or journal day with
 * the find bar on `query`, landed on match `index`. The search palette writes
 * it; the page consumes it once the tab shows and clears it, so coming back to
 * the tab later does not jump again.
 */
export const FIND_REQUEST_KEY = 'findRequest'

export interface FindRequest {
  query: string
  /** Position among the matches in document order. */
  index: number
}

export function readFindRequest(
  viewState: Record<string, unknown> | undefined
): FindRequest | null {
  const raw = viewState?.[FIND_REQUEST_KEY]
  if (typeof raw !== 'object' || raw === null) return null
  const { query, index } = raw as Partial<FindRequest>
  return typeof query === 'string' && query !== '' && Number.isInteger(index) && index! >= 0
    ? { query, index: index! }
    : null
}
