/**
 * Tab-scoped view state
 *
 * A `useState`-like API whose value lives in the owning tab's `viewState`, so it
 * survives a tab switch (which keeps the page instance alive but swaps its tab)
 * and a session restore.
 *
 * Keyed off `useTabIdentity`, not `useActiveTab`: the latter returns the
 * GLOBALLY active tab and would read/write the wrong tab for a page rendered in
 * the inactive pane of a split view.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTabActionsOptional } from '@/contexts/tabs'
import { useTabIdentity } from '@/contexts/tabs/tab-identity'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:TabViewState')

export interface UseTabViewStateOptions<T> {
  /** Key inside the tab's `viewState` record. */
  key: string
  /** Value used when nothing is stored, or when the stored value fails to parse. */
  defaultValue: T
  /**
   * Validates/narrows the persisted value. Persisted tab state can have been
   * written by an older app version, so this must be total: return `undefined`
   * (or throw — a throw is caught) to reject the stored value and fall back to
   * `defaultValue`.
   */
  parse: (raw: unknown) => T | undefined
}

export type TabViewStateSetter<T> = (next: T | ((previous: T) => T)) => void

export function useTabViewState<T>({
  key,
  defaultValue,
  parse
}: UseTabViewStateOptions<T>): [T, TabViewStateSetter<T>] {
  const identity = useTabIdentity()
  const actions = useTabActionsOptional()
  const dispatch = actions?.dispatch
  const getTab = actions?.getTab

  const parseRef = useRef(parse)
  const defaultValueRef = useRef(defaultValue)
  const identityRef = useRef(identity)

  useLayoutEffect(() => {
    parseRef.current = parse
    defaultValueRef.current = defaultValue
    identityRef.current = identity
  })

  const read = useCallback((): T => {
    const current = identityRef.current
    if (!current) return defaultValueRef.current

    const raw = getTab?.(current.tabId, current.groupId)?.viewState?.[key]
    if (raw === undefined) return defaultValueRef.current

    try {
      const parsed = parseRef.current(raw)
      return parsed === undefined ? defaultValueRef.current : parsed
    } catch (err) {
      // Diagnostic only — a rejected view-state value is never surfaced to the
      // user, the hook just falls back to the default.
      log.warn('discarding unparseable tab view state', { key, error: String(err) })
      return defaultValueRef.current
    }
  }, [getTab, key])

  const [value, setValue] = useState<T>(read)
  const valueRef = useRef(value)

  // Re-seed when the tab this component is rendered for changes. `TabContent`
  // reuses its page instance across a tab switch, so without this the new tab
  // would inherit the previous tab's state.
  const identityKey = identity ? `${identity.groupId}:${identity.tabId}` : ''
  const seededForRef = useRef(identityKey)
  useEffect(() => {
    if (seededForRef.current === identityKey) return
    seededForRef.current = identityKey
    const seeded = read()
    valueRef.current = seeded
    setValue(seeded)
  }, [identityKey, read])

  const setTabViewState = useCallback<TabViewStateSetter<T>>(
    (next) => {
      const resolved =
        typeof next === 'function' ? (next as (previous: T) => T)(valueRef.current) : next
      valueRef.current = resolved
      setValue(resolved)

      const current = identityRef.current
      if (!current || !dispatch) return
      dispatch({
        type: 'SAVE_TAB_STATE',
        payload: {
          tabId: current.tabId,
          groupId: current.groupId,
          viewState: { [key]: resolved }
        }
      })
    },
    [dispatch, key]
  )

  return [value, setTabViewState]
}
