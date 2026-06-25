import type { WidgetSize } from './types'

// react-grid-layout config for the Home board. Responsive: column count drops at narrow widths;
// RGL derives the narrower breakpoint layouts from the stored `lg` layout.
export const GRID_BREAKPOINTS = { lg: 1024, md: 768, sm: 0 } as const
export const GRID_COLS = { lg: 8, md: 4, sm: 2 } as const
export const GRID_ROW_HEIGHT = 56 // px per row unit
export const GRID_MARGIN: [number, number] = [12, 12]

// Default minimum span any widget can shrink to (a widget shorter than this can't show its header
// plus content). Per-widget overrides come from WidgetDefinition.minLayout.
export const MIN_W = 2
export const MIN_H = 2

// Content-density tier derived from a widget's row span. Widgets read this to decide how many
// items to show (see inboxWidgetLimit and the size===... lines in the widget bodies).
export function sizeTier(_w: number, h: number): WidgetSize {
  if (h <= 2) return 'S'
  if (h <= 4) return 'M'
  return 'L'
}
