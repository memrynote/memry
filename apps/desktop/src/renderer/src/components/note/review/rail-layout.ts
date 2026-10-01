export const RAIL_ITEM_GAP = 10

export interface RailLayoutItem {
  id: string
  desiredTop: number
  order: number
}

/**
 * Side-rail card tops: each card wants to sit level with its line in the
 * note, and cards that would overlap are pushed down, in document order, to
 * leave `gap` between them. Shared by the review rail and the writing rails.
 */
export function layoutRailItems(
  items: RailLayoutItem[],
  heights: Record<string, number>,
  gap = RAIL_ITEM_GAP
): Record<string, number> {
  const sorted = [...items].sort((a, b) => a.desiredTop - b.desiredTop || a.order - b.order)
  const positions: Record<string, number> = {}
  let previousBottom = 0
  sorted.forEach((item, index) => {
    const top = Math.max(item.desiredTop, index === 0 ? 0 : previousBottom + gap)
    positions[item.id] = top
    previousBottom = top + (heights[item.id] ?? 0)
  })
  return positions
}

export function areNumberRecordsEqual(
  previous: Record<string, number>,
  next: Record<string, number>
): boolean {
  const previousKeys = Object.keys(previous)
  const nextKeys = Object.keys(next)
  return (
    previousKeys.length === nextKeys.length && nextKeys.every((key) => previous[key] === next[key])
  )
}
