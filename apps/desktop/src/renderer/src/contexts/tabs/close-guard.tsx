/**
 * Tab Close Guard
 *
 * Lets a tab's page veto its own close while it holds unsaved work. The
 * registry lives here rather than in context.tsx so the context file does not
 * grow another responsibility; the provider wires it in and every close path
 * (X button, middle-click, context menu, ⌘W, close others/right/all) inherits
 * the behaviour for free.
 */

import { useCallback, useRef, useState } from 'react'

export interface TabCloseGuard {
  /** True while the tab holds work that would be lost on close. */
  isDirty: () => boolean
  /** Persist the pending work. Resolve false to keep the tab open. */
  save: () => Promise<boolean>
}

export interface PendingClosePrompt {
  tabId: string
}

export type PendingCloseResolution = 'save' | 'discard' | 'cancel'

export interface CloseGuardRegistry {
  registerCloseGuard: (tabId: string, guard: TabCloseGuard) => () => void
  /**
   * Run `commit` once every dirty guarded tab in `tabIds` has been resolved.
   * Commits synchronously when nothing in the set is dirty.
   */
  requestClose: (tabIds: string[], commit: () => void) => void
  pending: PendingClosePrompt | null
  resolvePending: (resolution: PendingCloseResolution) => Promise<void>
}

export function useCloseGuardRegistry(): CloseGuardRegistry {
  const guardsRef = useRef(new Map<string, TabCloseGuard>())
  const queueRef = useRef<string[]>([])
  const commitRef = useRef<(() => void) | null>(null)
  const [pending, setPending] = useState<PendingClosePrompt | null>(null)

  const registerCloseGuard = useCallback((tabId: string, guard: TabCloseGuard) => {
    guardsRef.current.set(tabId, guard)
    return () => {
      guardsRef.current.delete(tabId)
    }
  }, [])

  const advance = useCallback(() => {
    const next = queueRef.current.shift()
    if (next) {
      setPending({ tabId: next })
      return
    }
    setPending(null)
    const commit = commitRef.current
    commitRef.current = null
    commit?.()
  }, [])

  const requestClose = useCallback(
    (tabIds: string[], commit: () => void) => {
      const dirty = tabIds.filter((id) => guardsRef.current.get(id)?.isDirty() === true)
      if (dirty.length === 0) {
        commit()
        return
      }
      queueRef.current = dirty
      commitRef.current = commit
      advance()
    },
    [advance]
  )

  const resolvePending = useCallback(
    async (resolution: PendingCloseResolution) => {
      const current = pending
      if (!current) return

      if (resolution === 'cancel') {
        queueRef.current = []
        commitRef.current = null
        setPending(null)
        return
      }

      if (resolution === 'save') {
        const guard = guardsRef.current.get(current.tabId)
        const saved = guard ? await guard.save() : true
        // Failed save: leave the prompt up and the tab dirty rather than
        // silently discarding the user's work.
        if (!saved) return
      }

      advance()
    },
    [pending, advance]
  )

  return { registerCloseGuard, requestClose, pending, resolvePending }
}
