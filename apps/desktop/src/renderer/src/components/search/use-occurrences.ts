import { useEffect, useMemo, useRef, useState } from 'react'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { createLogger } from '@/lib/logger'
import { loadBodyMarkdown } from './search-bodies'
import { resultValue } from './search-result-item'
import { findOccurrences, type Occurrences } from './search-text'

const log = createLogger('SearchOccurrences')
/** Typing and arrowing should not fire a body read per intermediate state. */
const LOAD_DELAY_MS = 80

const NONE: Occurrences = { lines: [], hits: [] }

/**
 * Occurrences of the query in each result's body, read from the local vault.
 * A result missing from the map has not loaded yet, and one with no hits is
 * shown as a plain row. Only phrase hits count: that is the unit the find bar
 * will jump between once the note opens.
 */
export function useOccurrences(
  items: SearchResultItem[],
  query: string
): ReadonlyMap<string, Occurrences> {
  const needle = query.trim()
  const cache = useRef({ needle: '', byKey: new Map<string, Occurrences>() })
  const [version, rerender] = useState(0)

  if (cache.current.needle !== needle) cache.current = { needle, byKey: new Map() }

  const keyOf = (item: SearchResultItem): string => `${resultValue(item)}@${item.modifiedAt}`
  const missing = items.filter((item) => !cache.current.byKey.has(keyOf(item)))
  const missingToken = missing.map(keyOf).join('|')

  useEffect(() => {
    if (!needle || missing.length === 0) return
    let cancelled = false
    const target = cache.current
    const timer = setTimeout(() => {
      void Promise.all(
        missing.map(async (item) => {
          const markdown = await loadBodyMarkdown(item).catch((err) => {
            log.warn('Failed to read a note body for search matches', { id: item.id, err })
            return null
          })
          target.byKey.set(keyOf(item), markdown ? findOccurrences(markdown, needle) : NONE)
        })
      ).then(() => {
        if (!cancelled && cache.current === target) rerender((n) => n + 1)
      })
    }, LOAD_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // `missing` is derived from `missingToken`; listing it would re-arm the timer on every render.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [missingToken, needle])

  const itemsToken = items.map(keyOf).join('|')
  return useMemo(() => {
    const found = new Map<string, Occurrences>()
    for (const item of items) {
      const entry = cache.current.byKey.get(keyOf(item))
      if (entry && entry.hits.length > 0) found.set(resultValue(item), entry)
    }
    return found
    // `items` is derived from `itemsToken`; `version` marks a finished load.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [itemsToken, needle, version])
}
