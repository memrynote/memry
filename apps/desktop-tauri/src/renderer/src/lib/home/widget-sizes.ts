import type { WidgetSize } from './types'

// react-grid-layout config for the Home board. One fixed column count at every width — columns
// scale with the container instead of collapsing at breakpoints. A board has a single stored
// arrangement, so a responsive grid could only ever derive the narrow layouts from it and throw
// them away again; edits made at a narrow width were never persisted (issue #1216).
export const GRID_COLS = 8
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
