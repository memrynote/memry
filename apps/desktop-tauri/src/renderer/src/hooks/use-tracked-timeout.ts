/**
 * Tracked Timeout Hook
 *
 * `setTimeout` scheduled from a callback outlives the component that scheduled
 * it: the handle is unreachable, so nothing can cancel it and the callback's
 * closure (and everything it captures) stays alive until the timer fires.
 *
 * `useTrackedTimeout` hands back a scheduler that remembers every pending
 * handle and clears the whole set when the owning component unmounts.
 *
 * @module hooks/use-tracked-timeout
 */

import { useCallback, useEffect, useRef } from 'react'

/** Schedules `callback` after `delayMs`; cancelled automatically on unmount. */
export type TrackedTimeoutScheduler = (callback: () => void, delayMs: number) => void

/**
 * Returns a stable `setTimeout` wrapper whose pending timers are cleared on
 * unmount.
 *
 * @example
 * ```ts
 * const scheduleTimeout = useTrackedTimeout()
 * scheduleTimeout(() => setCopied(false), 2000)
 * ```
 */
export function useTrackedTimeout(): TrackedTimeoutScheduler {
  const handlesRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  useEffect(() => {
    const handles = handlesRef.current
    return () => {
      for (const handle of handles) clearTimeout(handle)
      handles.clear()
    }
  }, [])

  return useCallback((callback: () => void, delayMs: number) => {
    const handle = setTimeout(() => {
      handlesRef.current.delete(handle)
      callback()
    }, delayMs)
    handlesRef.current.add(handle)
  }, [])
}

export default useTrackedTimeout
