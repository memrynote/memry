/**
 * Guard for a restored entity id.
 *
 * Tab state outlives the entities it points at: a task gets deleted, an inbox
 * item gets archived (its item query is explicitly set to `null`), a project is
 * removed. Every surface here renders its detail drawer as `entity && <close
 * button/>`, so an id that no longer resolves paints a full-width blank drawer
 * with NO way to close it. `selectedProjectId` is worse than blank — the filter
 * keeps excluding tasks by the dead id while the picker falls back to showing
 * "All projects", so the UI claims everything and lists nothing.
 *
 * The id is dropped in the same render it fails to resolve (not one frame
 * later), and the owner is told to clear it from tab state.
 */

import { useEffect, useLayoutEffect, useRef } from 'react'

export interface UseResolvedEntityIdOptions {
  /** The id read out of tab state. */
  id: string | null
  /** Whether that id resolves against currently-loaded data. */
  exists: boolean
  /**
   * Whether the data to resolve against has actually loaded. While false the id
   * is kept: an empty list mid-fetch is not proof the entity is gone.
   */
  ready: boolean
  /** Clears the id from wherever it is persisted. */
  onMissing: () => void
}

export function useResolvedEntityId({
  id,
  exists,
  ready,
  onMissing
}: UseResolvedEntityIdOptions): string | null {
  const missing = id !== null && ready && !exists

  const onMissingRef = useRef(onMissing)
  useLayoutEffect(() => {
    onMissingRef.current = onMissing
  })

  // `id` is a dependency so that a SECOND stale id — a restore that lands while
  // the first clear is still in flight — is cleared too.
  useEffect(() => {
    if (missing) onMissingRef.current()
  }, [missing, id])

  return missing ? null : id
}
