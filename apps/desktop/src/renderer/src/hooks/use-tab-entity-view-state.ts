/**
 * Entity-stamped tab view state.
 *
 * `Tab.viewState` belongs to the TAB, and a tab outlives the entity it points
 * at: a file tab opened as a preview is reused for the next file the user
 * clicks, keeping its id, its viewState and its mounted page. A PDF's page
 * number, an image's zoom or an audio track's playback position stored plainly
 * would then be applied to a completely different file — page 12 of a 3-page
 * document, a zoom fitted to another image's aspect ratio, a seek past the end.
 *
 * `Tab.scrollPanes` already solved this by stamping every offset with the
 * entity it was measured against (`TabScrollEntry.entityId`). This is the same
 * stamp for values, so the two halves of "what this tab remembers" reject a
 * stale entity the same way.
 *
 * The check is done on READ rather than by clearing on navigation: the entity
 * can change without the page remounting, so there is no reliable moment to
 * clear at, and a read-time comparison is correct in the same render the new
 * entity arrives.
 */

import { useCallback, useMemo } from 'react'
import { useTabIdentity } from '@/contexts/tabs/tab-identity'
import { useTabViewState, type TabViewStateSetter } from './use-tab-view-state'

export interface StampedTabValue<T> {
  /** `Tab.entityId` at the moment the value was written. */
  entityId?: string
  value: T
}

/**
 * The stored value if it belongs to this entity, otherwise the fallback.
 *
 * A tab with no entity (Journal, Calendar, Tags) stamps `undefined` and matches
 * `undefined`, so those surfaces keep working without a special case.
 */
export function readStampedTabValue<T>(
  stored: StampedTabValue<T> | undefined,
  entityId: string | undefined,
  fallback: T
): T {
  if (stored === undefined) return fallback
  return stored.entityId === entityId ? stored.value : fallback
}

export interface UseTabEntityViewStateOptions<T> {
  key: string
  defaultValue: T
  /**
   * Validates the INNER value. Total, like `useTabViewState`'s: return
   * `undefined` to reject a value written by an older build.
   */
  parse: (raw: unknown) => T | undefined
}

export function useTabEntityViewState<T>({
  key,
  defaultValue,
  parse
}: UseTabEntityViewStateOptions<T>): [T, TabViewStateSetter<T>] {
  const entityId = useTabIdentity()?.entityId

  const parseStamped = useCallback(
    (raw: unknown): StampedTabValue<T> | undefined => {
      if (typeof raw !== 'object' || raw === null) return undefined
      const record = raw as { entityId?: unknown; value?: unknown }
      if (record.entityId !== undefined && typeof record.entityId !== 'string') return undefined
      const value = parse(record.value)
      if (value === undefined) return undefined
      return { entityId: record.entityId, value }
    },
    [parse]
  )

  const emptyStamp = useMemo<StampedTabValue<T>>(
    () => ({ entityId, value: defaultValue }),
    [entityId, defaultValue]
  )

  const [stored, setStored] = useTabViewState<StampedTabValue<T>>({
    key,
    defaultValue: emptyStamp,
    parse: parseStamped
  })

  const value = readStampedTabValue(stored, entityId, defaultValue)

  const setValue = useCallback<TabViewStateSetter<T>>(
    (next) => {
      setStored((previous) => ({
        entityId,
        value:
          typeof next === 'function'
            ? (next as (previousValue: T) => T)(
                readStampedTabValue(previous, entityId, defaultValue)
              )
            : next
      }))
    },
    [entityId, defaultValue, setStored]
  )

  return [value, setValue]
}
