export type WidgetSize = 'S' | 'M' | 'L'
export type WidgetType = 'recently-edited' | 'bookmarks' | 'tasks' | 'inbox' | 'folder'

export interface WidgetInstance {
  id: string
  type: WidgetType
  size: WidgetSize
  config: Record<string, unknown>
}

export interface HomePage {
  id: string
  name: string
  icon?: string
  position: number
  widgets: WidgetInstance[]
}
