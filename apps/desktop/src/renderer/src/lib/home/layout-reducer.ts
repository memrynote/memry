import type { HomePage, WidgetInstance } from './types'

export function addWidget(page: HomePage, widget: WidgetInstance): HomePage {
  return { ...page, widgets: [...page.widgets, widget] }
}

export function removeWidget(page: HomePage, id: string): HomePage {
  return { ...page, widgets: page.widgets.filter((w) => w.id !== id) }
}

// react-grid-layout reports a flat list of {i,x,y,w,h} on every drag/resize. Write those coords
// back onto the matching widgets by id; widgets not in the layout are left untouched.
export type GridLayoutItem = { i: string; x: number; y: number; w: number; h: number }

export function applyLayout(page: HomePage, layout: GridLayoutItem[]): HomePage {
  const byId = new Map(layout.map((l) => [l.i, l]))
  return {
    ...page,
    widgets: page.widgets.map((w) => {
      const l = byId.get(w.id)
      return l ? { ...w, x: l.x, y: l.y, w: l.w, h: l.h } : w
    })
  }
}

export function updateWidgetConfig(
  page: HomePage,
  widgetId: string,
  config: Record<string, unknown>
): HomePage {
  return {
    ...page,
    widgets: page.widgets.map((w) => (w.id === widgetId ? { ...w, config } : w))
  }
}

export function configureWidget(
  page: HomePage,
  id: string,
  config: Record<string, unknown>
): HomePage {
  return {
    ...page,
    widgets: page.widgets.map((w) =>
      w.id === id ? { ...w, config: { ...w.config, ...config } } : w
    )
  }
}
