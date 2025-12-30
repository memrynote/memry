/**
 * Display Density Hook
 *
 * Manages user preference for display density (comfortable vs compact).
 * Persists preference to localStorage for persistence across sessions.
 */

import { useState, useEffect, useCallback } from 'react'

export type DisplayDensity = 'comfortable' | 'compact'

const STORAGE_KEY = 'memry-display-density'
const DEFAULT_DENSITY: DisplayDensity = 'comfortable'

/**
 * Hook to manage display density preference
 */
export function useDisplayDensity() {
  const [density, setDensityState] = useState<DisplayDensity>(() => {
    // Initialize from localStorage if available
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === 'comfortable' || stored === 'compact') {
        return stored
      }
    }
    return DEFAULT_DENSITY
  })

  // Persist to localStorage when density changes
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, density)
  }, [density])

  const setDensity = useCallback((newDensity: DisplayDensity) => {
    setDensityState(newDensity)
  }, [])

  const toggleDensity = useCallback(() => {
    setDensityState((prev) => (prev === 'comfortable' ? 'compact' : 'comfortable'))
  }, [])

  const isCompact = density === 'compact'
  const isComfortable = density === 'comfortable'

  return {
    density,
    setDensity,
    toggleDensity,
    isCompact,
    isComfortable
  }
}

/**
 * Density-aware class name helper
 * Returns different classes based on the current density setting
 */
export function densityClasses(
  density: DisplayDensity,
  comfortable: string,
  compact: string
): string {
  return density === 'compact' ? compact : comfortable
}

/**
 * Density configuration values for consistent styling
 */
export const DENSITY_CONFIG = {
  comfortable: {
    // Page layout
    pagePadding: 'px-6 lg:px-8 py-8 lg:py-12',
    headerMargin: 'mb-8 lg:mb-10',
    sectionSpacing: 'space-y-6',

    // Watermark
    watermarkSize: 'text-[8rem] lg:text-[10rem]',
    watermarkOffset: '-left-2 lg:-left-4 -top-4 lg:-top-6',

    // Capture input
    captureMargin: 'mb-6',
    capturePadding: 'px-4 py-3',
    captureGap: 'gap-3',
    captureRadius: 'rounded-xl',

    // List items
    itemPadding: 'px-3 py-2.5',
    itemGap: 'gap-3',
    itemRadius: 'rounded-lg',
    iconSize: 'w-9 h-9',
    iconInnerSize: 'w-4 h-4',
    checkboxSize: '',

    // Section headers
    sectionHeaderMargin: 'mb-2.5',
    sectionTitleSize: 'text-xs',

    // Typography
    titleSize: 'text-sm',
    metaSize: 'text-xs',

    // Row height (approximate)
    rowHeight: 48
  },
  compact: {
    // Page layout
    pagePadding: 'px-4 lg:px-6 py-4 lg:py-6',
    headerMargin: 'mb-4 lg:mb-5',
    sectionSpacing: 'space-y-4',

    // Watermark
    watermarkSize: 'text-[5rem] lg:text-[6rem]',
    watermarkOffset: '-left-1 lg:-left-2 -top-2 lg:-top-3',

    // Capture input
    captureMargin: 'mb-4',
    capturePadding: 'px-3 py-2',
    captureGap: 'gap-2',
    captureRadius: 'rounded-lg',

    // List items
    itemPadding: 'px-2 py-1.5',
    itemGap: 'gap-2',
    itemRadius: 'rounded-md',
    iconSize: 'w-7 h-7',
    iconInnerSize: 'w-3.5 h-3.5',
    checkboxSize: 'h-3.5 w-3.5',

    // Section headers
    sectionHeaderMargin: 'mb-1.5',
    sectionTitleSize: 'text-[11px]',

    // Typography
    titleSize: 'text-[13px]',
    metaSize: 'text-[11px]',

    // Row height (approximate)
    rowHeight: 36
  }
} as const

export type DensityConfig = {
  pagePadding: string
  headerMargin: string
  sectionSpacing: string
  watermarkSize: string
  watermarkOffset: string
  captureMargin: string
  capturePadding: string
  captureGap: string
  captureRadius: string
  itemPadding: string
  itemGap: string
  itemRadius: string
  iconSize: string
  iconInnerSize: string
  checkboxSize: string
  sectionHeaderMargin: string
  sectionTitleSize: string
  titleSize: string
  metaSize: string
  rowHeight: number
}
