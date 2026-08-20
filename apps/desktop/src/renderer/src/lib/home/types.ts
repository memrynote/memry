// Content-density tier, now DERIVED from a widget's row count (see sizeTier in widget-sizes.ts).
// No longer stored — widgets still read it to decide how many items to show.
export type WidgetSize = 'S' | 'M' | 'L'
export type WidgetType =
  | 'recently-edited'
  | 'bookmarks'
  | 'tasks'
  | 'inbox'
  | 'folder'
  | 'calendar'
  | 'journal'
  | 'project'

export interface WidgetInstance {
  id: string
  type: WidgetType
  // Free-form grid placement (react-grid-layout units). x/y = top-left cell, w/h = span.
  x: number
  y: number
  w: number
  h: number
  config: Record<string, unknown>
}

export interface HomePage {
  id: string
  name: string
  icon?: string
  position: number
  widgets: WidgetInstance[]
}
