import { useSyncExternalStore } from 'react'

const COMPACT_RAIL_QUERY = '(max-width: 1180px)'

function getCompactRailSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(COMPACT_RAIL_QUERY).matches
}

function subscribeCompactRail(callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }

  const query = window.matchMedia(COMPACT_RAIL_QUERY)
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', callback)
    return () => query.removeEventListener('change', callback)
  }

  query.addListener(callback)
  return () => query.removeListener(callback)
}

export function useCompactCommentsRail(): boolean {
  return useSyncExternalStore(subscribeCompactRail, getCompactRailSnapshot, () => false)
}
