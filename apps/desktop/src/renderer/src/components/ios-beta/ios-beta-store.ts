import { useSyncExternalStore } from 'react'

import { createLogger } from '@/lib/logger'

const log = createLogger('IosBetaStore')

const STORAGE_KEY = 'memry:ios-beta'

/**
 * Local to this install: where the beta invite went, and whether the one-time launch prompt
 * was already shown and closed. Not synced, since each desktop asks on its own.
 */
export interface IosBetaState {
  joinedEmail: string | null
  promptSeen: boolean
}

const EMPTY: IosBetaState = { joinedEmail: null, promptSeen: false }

const read = (): IosBetaState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return EMPTY
    const fields: { joinedEmail?: unknown; promptSeen?: unknown } = parsed
    return {
      joinedEmail: typeof fields.joinedEmail === 'string' ? fields.joinedEmail : null,
      promptSeen: fields.promptSeen === true
    }
  } catch (error) {
    log.warn('iPhone beta state unreadable; starting fresh', error)
    return EMPTY
  }
}

let snapshot: IosBetaState | null = null
const listeners = new Set<() => void>()

const getSnapshot = (): IosBetaState => (snapshot ??= read())

const write = (next: IosBetaState): void => {
  snapshot = next
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const markIosBetaJoined = (email: string): void =>
  write({ ...getSnapshot(), joinedEmail: email })

export const markIosBetaPromptSeen = (): void => write({ ...getSnapshot(), promptSeen: true })

export const useIosBetaState = (): IosBetaState =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
