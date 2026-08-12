/**
 * Undo Hook
 *
 * Provides global undo tracking and Cmd+Z keyboard shortcut support.
 * Works with the existing toast-based undo system by tracking the last
 * undo function globally.
 *
 * T051-T054: Client-side undo for task operations
 *
 * NOTE: This is a client-side only feature. Undo data is stored in memory
 * and will be lost on page refresh. The undo functionality relies on
 * capturing task state at the time of the action, which is not persisted
 * to the database. This is an acceptable limitation per the spec.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { createLogger } from '@/lib/logger'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('Hook:Undo')

// ============================================================================
// GLOBAL UNDO STACK
// ============================================================================

/** Maximum number of undo actions to track */
const MAX_UNDO_STACK_SIZE = 10

/** Time in ms before an undo action expires (10 seconds per spec) */
const UNDO_EXPIRY_MS = 10_000

interface UndoEntry {
  id: string
  description: string
  undoFn: () => void
  timestamp: number
}

// Global undo stack - shared across all components
let globalUndoStack: UndoEntry[] = []
const globalUndoListeners: Set<() => void> = new Set()

// Clean up expired entries periodically
let cleanupInterval: ReturnType<typeof setInterval> | null = null

function startCleanupInterval() {
  if (cleanupInterval) return
  cleanupInterval = setInterval(() => {
    const pruned = pruneExpiredEntries()
    if (globalUndoStack.length === 0) {
      stopCleanupInterval()
    }
    if (pruned) {
      notifyListeners()
    }
  }, 1000)
  cleanupInterval.unref?.()
}

function stopCleanupInterval() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = null
  }
}

/**
 * Immutable view of the stack that `useSyncExternalStore` renders from.
 * Recomputed only inside `notifyListeners`, so `getUndoSnapshot` can stay pure
 * and returns a referentially stable object between mutations (a fresh object
 * on every read would make `useSyncExternalStore` loop forever).
 */
interface UndoSnapshot {
  canUndo: boolean
  lastActionDescription: string | null
}

let undoSnapshot: UndoSnapshot = { canUndo: false, lastActionDescription: null }

function refreshSnapshot() {
  const last = globalUndoStack[globalUndoStack.length - 1]
  const canUndo = !!last
  const lastActionDescription = last?.description ?? null
  if (
    undoSnapshot.canUndo === canUndo &&
    undoSnapshot.lastActionDescription === lastActionDescription
  ) {
    return
  }
  undoSnapshot = { canUndo, lastActionDescription }
}

function getUndoSnapshot(): UndoSnapshot {
  return undoSnapshot
}

function subscribeToUndoStack(listener: () => void): () => void {
  globalUndoListeners.add(listener)
  return () => {
    globalUndoListeners.delete(listener)
    if (globalUndoListeners.size === 0) {
      globalUndoStack = []
      stopCleanupInterval()
      refreshSnapshot()
    }
  }
}

function notifyListeners() {
  refreshSnapshot()
  globalUndoListeners.forEach((listener) => listener())
}

/**
 * Drop entries older than `UNDO_EXPIRY_MS`. Returns whether anything was removed.
 * Callers are responsible for notifying listeners — never call this during render.
 */
function pruneExpiredEntries(): boolean {
  const now = Date.now()
  const before = globalUndoStack.length
  globalUndoStack = globalUndoStack.filter((entry) => now - entry.timestamp < UNDO_EXPIRY_MS)
  if (globalUndoStack.length === before) return false
  if (globalUndoStack.length === 0) {
    stopCleanupInterval()
  }
  return true
}

function pushUndoEntry(entry: Omit<UndoEntry, 'id' | 'timestamp'>) {
  const newEntry: UndoEntry = {
    ...entry,
    id: `undo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: Date.now()
  }

  // Add to stack, remove oldest if over limit
  globalUndoStack.push(newEntry)
  if (globalUndoStack.length > MAX_UNDO_STACK_SIZE) {
    globalUndoStack.shift()
  }

  startCleanupInterval()
  notifyListeners()

  return newEntry.id
}

/**
 * Take the newest live entry off the stack. Prunes first so an expired entry can
 * never be handed back between 1 s sweeps, whichever accessor the caller used.
 */
function popUndoEntry(): UndoEntry | undefined {
  pruneExpiredEntries()
  const entry = globalUndoStack.pop()
  if (globalUndoStack.length === 0) {
    stopCleanupInterval()
  }
  notifyListeners()
  return entry
}

function removeUndoEntryById(id: string): boolean {
  const idx = globalUndoStack.findIndex((entry) => entry.id === id)
  if (idx === -1) return false

  globalUndoStack.splice(idx, 1)
  if (globalUndoStack.length === 0) {
    stopCleanupInterval()
  }
  notifyListeners()
  return true
}

/** Read the newest live entry. Mutates the stack, so event handlers only. */
function getLastUndoEntry(): UndoEntry | undefined {
  if (pruneExpiredEntries()) {
    notifyListeners()
  }
  return globalUndoStack[globalUndoStack.length - 1]
}

// ============================================================================
// HOOK: useUndoTracker
// ============================================================================

interface UseUndoTrackerReturn {
  /** Register an undo action */
  registerUndo: (description: string, undoFn: () => void) => string
  /** Remove a specific undo entry by ID (prevents double-fire from toast + Cmd+Z) */
  removeUndoEntry: (id: string) => void
  /** Execute the last undo action */
  undo: () => boolean
  /** Whether there's an action that can be undone */
  canUndo: boolean
  /** Description of the last undoable action */
  lastActionDescription: string | null
}

/**
 * Hook to track and execute undo actions.
 * Used by components that perform undoable operations.
 */
export const useUndoTracker = (): UseUndoTrackerReturn => {
  const { t } = useT('common')

  // Re-render when the stack changes. `getUndoSnapshot` is pure and returns a
  // stable reference until a mutation actually changes the derived values.
  const snapshot = useSyncExternalStore(subscribeToUndoStack, getUndoSnapshot, getUndoSnapshot)

  const registerUndo = useCallback((description: string, undoFn: () => void): string => {
    return pushUndoEntry({ description, undoFn })
  }, [])

  const removeUndoEntry = useCallback((id: string): void => {
    removeUndoEntryById(id)
  }, [])

  const undo = useCallback((): boolean => {
    const entry = popUndoEntry()
    if (!entry) {
      return false
    }

    try {
      entry.undoFn()
      toast.success(t('toast.undone', { description: entry.description }))
      return true
    } catch (error) {
      log.error('Error executing undo:', error)
      toast.error(t('toast.undoFailed'))
      return false
    }
  }, [t])

  return {
    registerUndo,
    removeUndoEntry,
    undo,
    canUndo: snapshot.canUndo,
    lastActionDescription: snapshot.lastActionDescription
  }
}

// ============================================================================
// HOOK: useUndoKeyboardShortcut
// ============================================================================

/**
 * Hook to add Cmd+Z (Mac) / Ctrl+Z (Windows) keyboard shortcut for undo.
 * Should be used once in the app, typically at the top level.
 */
export const useUndoKeyboardShortcut = (): void => {
  const { t } = useT('common')

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+Z on Mac, Ctrl+Z on Windows/Linux
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const modifier = isMac ? e.metaKey : e.ctrlKey

      if (modifier && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        // Don't intercept if in an input field (let native undo work)
        const target = e.target as HTMLElement
        const isInputField =
          target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

        if (isInputField) {
          return // Let native text undo work
        }

        // Check if there's something to undo. Nothing to undo → do nothing (no toast).
        const entry = getLastUndoEntry()
        if (entry) {
          e.preventDefault()
          const popped = popUndoEntry()
          if (popped) {
            try {
              popped.undoFn()
              toast.success(t('toast.undone', { description: popped.description }))
            } catch (error) {
              log.error('Keyboard shortcut undo error:', error)
              toast.error(t('toast.undoFailed'))
            }
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [t])
}

// ============================================================================
// HELPER: createUndoableAction
// ============================================================================

/**
 * Helper to create an undoable action with automatic registration.
 * Returns a function that performs the action and registers undo.
 */
export function createUndoableAction<T>(
  description: string,
  action: () => T,
  undoFn: () => void
): () => T {
  return () => {
    const result = action()
    pushUndoEntry({ description, undoFn })
    return result
  }
}

export default useUndoTracker
