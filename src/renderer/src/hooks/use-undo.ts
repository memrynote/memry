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

import { useCallback, useEffect } from 'react'
import { createLogger } from '@/lib/logger'
import { toast } from 'sonner'

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
    const now = Date.now()
    const hadEntries = globalUndoStack.length > 0
    globalUndoStack = globalUndoStack.filter((entry) => now - entry.timestamp < UNDO_EXPIRY_MS)
    if (globalUndoStack.length === 0) {
      stopCleanupInterval()
    }
    if (hadEntries && globalUndoStack.length === 0) {
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

function notifyListeners() {
  globalUndoListeners.forEach((listener) => listener())
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

function popUndoEntry(): UndoEntry | undefined {
  const entry = globalUndoStack.pop()
  if (globalUndoStack.length === 0) {
    stopCleanupInterval()
  }
  notifyListeners()
  return entry
}

function getLastUndoEntry(): UndoEntry | undefined {
  // Filter out expired entries
  const now = Date.now()
  globalUndoStack = globalUndoStack.filter((entry) => now - entry.timestamp < UNDO_EXPIRY_MS)
  if (globalUndoStack.length === 0) {
    stopCleanupInterval()
  }
  return globalUndoStack[globalUndoStack.length - 1]
}

// ============================================================================
// HOOK: useUndoTracker
// ============================================================================

interface UseUndoTrackerReturn {
  /** Register an undo action */
  registerUndo: (description: string, undoFn: () => void) => string
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
  // Force re-render when stack changes
  const forceUpdate = useCallback(() => {}, [])

  useEffect(() => {
    globalUndoListeners.add(forceUpdate)
    return () => {
      globalUndoListeners.delete(forceUpdate)
      if (globalUndoListeners.size === 0) {
        globalUndoStack = []
        stopCleanupInterval()
      }
    }
  }, [forceUpdate])

  const registerUndo = useCallback((description: string, undoFn: () => void): string => {
    return pushUndoEntry({ description, undoFn })
  }, [])

  const undo = useCallback((): boolean => {
    const entry = popUndoEntry()
    if (!entry) {
      toast.info('Nothing to undo')
      return false
    }

    try {
      entry.undoFn()
      toast.success(`Undone: ${entry.description}`)
      return true
    } catch (error) {
      log.error('Error executing undo:', error)
      toast.error('Failed to undo action')
      return false
    }
  }, [])

  const lastEntry = getLastUndoEntry()

  return {
    registerUndo,
    undo,
    canUndo: !!lastEntry,
    lastActionDescription: lastEntry?.description ?? null
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

        // Check if there's something to undo
        const entry = getLastUndoEntry()
        if (entry) {
          e.preventDefault()
          const popped = popUndoEntry()
          if (popped) {
            try {
              popped.undoFn()
              toast.success(`Undone: ${popped.description}`)
            } catch (error) {
              log.error('Keyboard shortcut undo error:', error)
              toast.error('Failed to undo action')
            }
          }
        } else {
          // Still prevent default but show info
          e.preventDefault()
          toast.info('Nothing to undo', { duration: 2000 })
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
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
