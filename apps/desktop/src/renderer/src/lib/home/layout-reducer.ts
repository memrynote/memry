import type { HomePage, WidgetInstance, WidgetSize } from './types'

export function addWidget(page: HomePage, widget: WidgetInstance): HomePage {
  return { ...page, widgets: [...page.widgets, widget] }
}

export function removeWidget(page: HomePage, id: string): HomePage {
  return { ...page, widgets: page.widgets.filter((w) => w.id !== id) }
}

export function moveWidget(page: HomePage, activeId: string, overId: string): HomePage {
  if (activeId === overId) return page
  const from = page.widgets.findIndex((w) => w.id === activeId)
  const to = page.widgets.findIndex((w) => w.id === overId)
  if (from === -1 || to === -1) return page
  const next = [...page.widgets]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return { ...page, widgets: next }
}

export function resizeWidget(page: HomePage, id: string, size: WidgetSize): HomePage {
  return {
    ...page,
    widgets: page.widgets.map((w) => (w.id === id ? { ...w, size } : w))
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
