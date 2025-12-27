/**
 * Sidebar Drill-Down Context
 *
 * Manages the sidebar navigation state for drill-down views like tag details.
 * Uses a stack-based approach where views can be pushed/popped.
 */

import * as React from 'react'
import { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react'

// ============================================================================
// Types
// ============================================================================

export type DrillDownViewType = 'main' | 'tag'

export interface MainView {
  type: 'main'
}

export interface TagView {
  type: 'tag'
  tag: string
  color: string
}

export type DrillDownView = MainView | TagView

export interface SidebarDrillDownState {
  /** Current view stack */
  viewStack: DrillDownView[]
  /** Current (top) view */
  currentView: DrillDownView
  /** Whether we're at the main view */
  isAtMain: boolean
  /** Animation direction for transitions */
  animationDirection: 'left' | 'right' | null
}

export interface SidebarDrillDownActions {
  /** Navigate to a tag detail view */
  openTag: (tag: string, color: string) => void
  /** Go back to the previous view */
  goBack: () => void
  /** Reset to main view */
  resetToMain: () => void
}

export type SidebarDrillDownContextValue = SidebarDrillDownState & SidebarDrillDownActions

// ============================================================================
// Context
// ============================================================================

const SidebarDrillDownContext = createContext<SidebarDrillDownContextValue | null>(null)

// ============================================================================
// Provider
// ============================================================================

interface SidebarDrillDownProviderProps {
  children: React.ReactNode
}

const MAIN_VIEW: MainView = { type: 'main' }

export function SidebarDrillDownProvider({ children }: SidebarDrillDownProviderProps) {
  const [viewStack, setViewStack] = useState<DrillDownView[]>([MAIN_VIEW])
  const [animationDirection, setAnimationDirection] = useState<'left' | 'right' | null>(null)

  // Current view is the top of the stack
  const currentView = viewStack[viewStack.length - 1]
  const isAtMain = currentView.type === 'main'

  // Clear animation direction after transition
  useEffect(() => {
    if (animationDirection) {
      const timer = setTimeout(() => {
        setAnimationDirection(null)
      }, 200) // Match CSS transition duration
      return () => clearTimeout(timer)
    }
    return undefined
  }, [animationDirection])

  // Navigate to tag detail view
  const openTag = useCallback((tag: string, color: string) => {
    setAnimationDirection('left') // Slide left to reveal new view
    setViewStack((prev) => [...prev, { type: 'tag', tag, color }])
  }, [])

  // Go back to previous view
  const goBack = useCallback(() => {
    setViewStack((prev) => {
      if (prev.length <= 1) {
        return prev
      }
      return prev.slice(0, -1)
    })
    setAnimationDirection('right') // Slide right to go back
  }, [])

  // Reset to main view
  const resetToMain = useCallback(() => {
    setViewStack([MAIN_VIEW])
    setAnimationDirection('right')
  }, [])

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape to go back
      if (e.key === 'Escape' && !isAtMain) {
        e.preventDefault()
        goBack()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isAtMain, goBack])

  const value = useMemo<SidebarDrillDownContextValue>(
    () => ({
      viewStack,
      currentView,
      isAtMain,
      animationDirection,
      openTag,
      goBack,
      resetToMain
    }),
    [viewStack, currentView, isAtMain, animationDirection, openTag, goBack, resetToMain]
  )

  return (
    <SidebarDrillDownContext.Provider value={value}>{children}</SidebarDrillDownContext.Provider>
  )
}

// ============================================================================
// Hook
// ============================================================================

export function useSidebarDrillDown(): SidebarDrillDownContextValue {
  const context = useContext(SidebarDrillDownContext)
  if (!context) {
    throw new Error('useSidebarDrillDown must be used within a SidebarDrillDownProvider')
  }
  return context
}
