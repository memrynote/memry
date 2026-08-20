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
  // Grid span a new instance gets (react-grid-layout units). minLayout clamps how far the user
  // can shrink it via the resize grip; defaults to MIN_W/MIN_H.
  defaultLayout: { w: number; h: number }
  minLayout?: { w: number; h: number }
  defaultConfig: Record<string, unknown>
  Component: FC<WidgetComponentProps>
  ConfigEditor?: FC<WidgetConfigEditorProps>
  // Optional header slots rendered inside WidgetFrame: a filter control (left of the spacer)
  // and a count (right of the spacer). Used by the Tasks widget.
  // `Title` replaces the static `titleKey` label when a widget's header names the thing it is
  // configured to show rather than the widget type — the Project widget renders the project's
  // own name and icon, which three side-by-side instances need to tell each other apart.
  Title?: FC<WidgetComponentProps>
  HeaderFilter?: FC<WidgetConfigEditorProps>
  HeaderCount?: FC<WidgetComponentProps>
  // Optional footer pinned below the scroll area. Used by the Inbox widget (triage row).
  Footer?: FC<WidgetComponentProps>
}

// Entries are populated in Task 9 (real widgets) via registerWidget().
export const WIDGET_REGISTRY: Record<string, WidgetDefinition> = {}

export function registerWidget(def: WidgetDefinition): void {
  WIDGET_REGISTRY[def.type] = def
}

export function createWidget(type: WidgetType, existing: WidgetInstance[] = []): WidgetInstance {
  const def = WIDGET_REGISTRY[type]
  if (!def) throw new Error(`Unknown widget type: ${type}`)
  // Drop the new widget at the bottom of the board; react-grid-layout compacts it up from there.
  const bottom = existing.reduce((max, w) => Math.max(max, w.y + w.h), 0)
  return {
    id: nanoid(),
    type,
    x: 0,
    y: bottom,
    w: def.defaultLayout.w,
    h: def.defaultLayout.h,
    config: { ...def.defaultConfig }
  }
}
