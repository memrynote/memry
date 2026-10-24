import { useSyncExternalStore } from 'react'

import type { AgentReviewTarget } from '@memry/contracts/ipc-agent'

/**
 * Pages in this window that can review an agent edit in place.
 *
 * The agent pane reads this to decide what a pending body edit offers: when
 * the note or journal is already mounted (in the active tab or a background
 * one), the decision belongs to that page; when it is not, the pane offers to
 * open it or to accept without looking. Counted, not a set, because two panes
 * of a split view can show the same note.
 */
const hosts = new Map<string, number>()
const listeners = new Set<() => void>()

export function reviewTargetKey(target: AgentReviewTarget): string {
  return target.kind === 'note' ? `note:${target.id}` : `journal:${target.date}`
}

function notify(): void {
  for (const listener of listeners) listener()
}

export function registerReviewHost(target: AgentReviewTarget): () => void {
  const key = reviewTargetKey(target)
  hosts.set(key, (hosts.get(key) ?? 0) + 1)
  notify()
  return () => {
    const count = (hosts.get(key) ?? 0) - 1
    if (count > 0) hosts.set(key, count)
    else hosts.delete(key)
    notify()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useIsReviewHostMounted(target: AgentReviewTarget | null | undefined): boolean {
  const key = target ? reviewTargetKey(target) : null
  return useSyncExternalStore(subscribe, () => (key ? hosts.has(key) : false))
}
