import { nanoid } from 'nanoid'
import type { FC } from 'react'
import type { WidgetInstance, WidgetSize, WidgetType } from './types'

export interface WidgetComponentProps {
  config: Record<string, unknown>
  size: WidgetSize
}

export interface WidgetConfigEditorProps {
  config: Record<string, unknown>
  onChange: (config: Record<string, unknown>) => void
}

export interface WidgetDefinition {
  type: WidgetType
  titleKey: string
  icon: string
  sizes: WidgetSize[]
  defaultSize: WidgetSize
  defaultConfig: Record<string, unknown>
  Component: FC<WidgetComponentProps>
  ConfigEditor?: FC<WidgetConfigEditorProps>
}

// Entries are populated in Task 9 (real widgets) via registerWidget().
export const WIDGET_REGISTRY: Record<string, WidgetDefinition> = {}

export function registerWidget(def: WidgetDefinition): void {
  WIDGET_REGISTRY[def.type] = def
}

export function createWidget(type: WidgetType): WidgetInstance {
  const def = WIDGET_REGISTRY[type]
  if (!def) throw new Error(`Unknown widget type: ${type}`)
  return {
    id: nanoid(),
    type,
    size: def.defaultSize,
    config: { ...def.defaultConfig }
  }
}
