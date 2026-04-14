/**
 * Chord Shortcuts Hook
 * Handles two-key sequences (e.g., ⌘K ⌘→)
 */

import { useState, useEffect, useCallback } from 'react'
import { useTabs } from '@/contexts/tabs'
import { isMac } from './use-keyboard-shortcuts-base'
import { calculateGroupPositions, type GroupPosition } from './use-pane-navigation'
import { hintModeActiveRef } from '@/contexts/hint-mode'

// =============================================================================
// TYPES
// =============================================================================

interface ChordState {
  /** Whether chord sequence is active */
  isActive: boolean
  /** First key of the chord */
  firstKey: string | null
  /** Timeout reference */
  timeout: ReturnType<typeof setTimeout> | null
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Hook to handle two-key chord shortcuts (e.g., ⌘K ⌘→)
 * @returns Whether chord is currently active
 */
export const useChordShortcuts = (): boolean => {
  const { state, dispatch } = useTabs()
  const [chord, setChord] = useState<ChordState>({
    isActive: false,
    firstKey: null,
    timeout: null
  })

  /**
   * Start a chord sequence
   */
  const startChord = useCallback(
    (key: string) => {
      // Clear existing timeout
      if (chord.timeout) {
        clearTimeout(chord.timeout)
      }

      // Set timeout to cancel chord after 1 second
      const timeout = setTimeout(() => {
        setChord({
          isActive: false,
          firstKey: null,
          timeout: null
        })
      }, 1000)

      setChord({
        isActive: true,
        firstKey: key,
        timeout
      })
    },
    [chord.timeout]
  )

  /**
   * Handle the second key of a chord
   */
  const handleChordSecondKey = useCallback(
    (key: string, withShift: boolean): boolean => {
      if (!chord.isActive || !chord.firstKey) return false

      // Clear timeout
      if (chord.timeout) {
        clearTimeout(chord.timeout)
      }

      // Handle ⌘K chords
      if (chord.firstKey === 'k') {
        const groupIds = Object.keys(state.tabGroups)
        const currentIndex = groupIds.indexOf(state.activeGroupId)

        switch (key) {
          case 'ArrowRight':
            if (withShift) {
              // Move tab to next group (⌘K ⇧→)
              // TODO: Implement move tab to next group
            } else {
              // Focus next pane (⌘K ⌘→)
              const nextIndex = (currentIndex + 1) % groupIds.length
              dispatch({
                type: 'SET_ACTIVE_GROUP',
                payload: { groupId: groupIds[nextIndex] }
              })
            }
            break

          case 'ArrowLeft':
            if (withShift) {
              // Move tab to previous group (⌘K ⇧←)
              // TODO: Implement move tab to previous group
            } else {
              // Focus previous pane (⌘K ⌘←)
              const prevIndex = (currentIndex - 1 + groupIds.length) % groupIds.length
              dispatch({
                type: 'SET_ACTIVE_GROUP',
                payload: { groupId: groupIds[prevIndex] }
              })
            }
            break

          case 'ArrowUp':
            // Focus pane above (⌘K ⌘↑)
            focusPaneInDirection('up')
            break

          case 'ArrowDown':
            // Focus pane below (⌘K ⌘↓)
            focusPaneInDirection('down')
            break

          case 'm':
          case 'M':
            // Maximize/restore pane (⌘K ⌘M)
            // TODO: Add TOGGLE_MAXIMIZE_GROUP action
            break

          case '=':
            // Reset split ratios (⌘K ⌘=)
            // TODO: Add RESET_SPLIT_RATIOS action
            break
        }
      }

      // Reset chord state
      setChord({
        isActive: false,
        firstKey: null,
        timeout: null
      })

      return true
    },
    [chord, state.tabGroups, state.activeGroupId, dispatch]
  )

  /**
   * Focus pane in specified direction
   */
  const focusPaneInDirection = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down') => {
      const groupPositions: Record<string, GroupPosition> = calculateGroupPositions(state.layout)
      const currentPosition = groupPositions[state.activeGroupId]

      if (!currentPosition) return

      let targetGroupId: string | null = null
      let minDistance = Infinity

      const entries = Object.entries(groupPositions)
      for (const [groupId, position] of entries) {
        if (groupId === state.activeGroupId) continue

        let isInDirection = false
        let distance = 0

        switch (direction) {
          case 'left':
            isInDirection = position.centerX < currentPosition.centerX
            distance = currentPosition.centerX - position.centerX
            break
          case 'right':
            isInDirection = position.centerX > currentPosition.centerX
            distance = position.centerX - currentPosition.centerX
            break
          case 'up':
            isInDirection = position.centerY < currentPosition.centerY
            distance = currentPosition.centerY - position.centerY
            break
          case 'down':
            isInDirection = position.centerY > currentPosition.centerY
            distance = position.centerY - currentPosition.centerY
            break
        }

        if (isInDirection && distance < minDistance) {
          minDistance = distance
          targetGroupId = groupId
        }
      }

      if (targetGroupId) {
        dispatch({
          type: 'SET_ACTIVE_GROUP',
          payload: { groupId: targetGroupId }
        })
      }
    },
    [state.layout, state.activeGroupId, dispatch]
  )

  // Event listener for chord keys
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (hintModeActiveRef.current) return

      const metaOrCtrl = isMac ? e.metaKey : e.ctrlKey

      // Ignore if typing in input
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return
      }

      // Check for chord start (⌘K)
      if (metaOrCtrl && e.key.toLowerCase() === 'k' && !chord.isActive) {
        e.preventDefault()
        startChord('k')
        return
      }

      // Check for chord completion
      if (chord.isActive && (metaOrCtrl || e.shiftKey)) {
        e.preventDefault()
        handleChordSecondKey(e.key, e.shiftKey)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [chord.isActive, startChord, handleChordSecondKey])

  return chord.isActive
}

export default useChordShortcuts
