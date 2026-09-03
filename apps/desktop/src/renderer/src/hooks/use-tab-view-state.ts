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

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useTabActionsOptional } from '@/contexts/tabs'
import { useTabIdentity } from '@/contexts/tabs/tab-identity'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:TabViewState')

/**
 * Joins alias keys into one stable dependency token. NUL cannot occur in a
 * viewState key, and writing it as an escape keeps this file text: a literal
 * NUL byte makes git treat the source as binary, so it shows no diff in review.
 */
const ALIAS_SEPARATOR = '\u0000'

export interface UseTabViewStateOptions<T> {
  /** Key inside the tab's `viewState` record. */
  key: string
  /**
   * Older names for the same value, most recent first. Read as a fallback when
   * `key` is absent, and written alongside `key`, so a session written by this
   * build still restores on a build that only knows the old name.
   */
  aliasKeys?: string[]
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
  aliasKeys,
  defaultValue,
  parse
}: UseTabViewStateOptions<T>): [T, TabViewStateSetter<T>] {
  const identity = useTabIdentity()
  const actions = useTabActionsOptional()
  const dispatch = actions?.dispatch
  const getTab = actions?.getTab

  // `read()` is only ever called synchronously during render (the initial
  // `useState` seed below, and the re-seed-on-identity-change check further
  // down), so it can close over `identity`/`parse`/`defaultValue` directly —
  // no "latest ref" indirection needed, unlike `identityRef` below, which
  // `setTabViewState` reads from an event handler that can run long after the
  // render that created its closure.
  const identityRef = useRef(identity)
  useLayoutEffect(() => {
    identityRef.current = identity
  })

  // Joined so a fresh array literal on every render does not re-run the effects
  // that depend on `read`.
  const aliasToken = aliasKeys?.join(ALIAS_SEPARATOR) ?? ''

  const read = useCallback((): T => {
    if (!identity) return defaultValue

    const viewState = getTab?.(identity.tabId, identity.groupId)?.viewState
    const names = aliasToken === '' ? [key] : [key, ...aliasToken.split(ALIAS_SEPARATOR)]

    for (const name of names) {
      const raw = viewState?.[name]
      if (raw === undefined) continue
      try {
        const parsed = parse(raw)
        if (parsed !== undefined) return parsed
      } catch (err) {
        // Diagnostic only — a rejected view-state value is never surfaced to the
        // user, the hook just falls back to the default.
        log.warn('discarding unparseable tab view state', { key: name, error: String(err) })
      }
    }
    return defaultValue
  }, [identity, getTab, key, aliasToken, parse, defaultValue])

  const [value, setValue] = useState<T>(read)
  const valueRef = useRef(value)

  // Re-seed when the tab this component is rendered for changes. `TabContent`
  // reuses its page instance across a tab switch, so without this the new tab
  // would inherit the previous tab's state. Adjusted directly during render
  // (not in an effect), per
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  const identityKey = identity ? `${identity.groupId}:${identity.tabId}` : ''
  const [seededFor, setSeededFor] = useState(identityKey)
  if (seededFor !== identityKey) {
    setSeededFor(identityKey)
    const seeded = read()
    valueRef.current = seeded
    setValue(seeded)
  }

  const setTabViewState = useCallback<TabViewStateSetter<T>>(
    (next) => {
      const resolved =
        typeof next === 'function' ? (next as (previous: T) => T)(valueRef.current) : next
      valueRef.current = resolved
      setValue(resolved)

      const current = identityRef.current
      if (!current || !dispatch) return
      const viewState: Record<string, unknown> = { [key]: resolved }
      if (aliasToken !== '') {
        for (const alias of aliasToken.split(ALIAS_SEPARATOR)) viewState[alias] = resolved
      }
      dispatch({
        type: 'SAVE_TAB_STATE',
        payload: {
          tabId: current.tabId,
          groupId: current.groupId,
          viewState
        }
      })
    },
    [dispatch, key, aliasToken]
  )

  return [value, setTabViewState]
}
