/**
 * Pure active-card logic for the spatial canvas. Excalidraw-runtime-free (types
 * only) so it unit-tests in jsdom without the library or a real canvas.
 */
import type { CanvasCardRef } from './canvas-cards'

/**
 * Topmost card under a scene-space point, honoring each card's rotation.
 * Cards are in z-order (last is topmost); we scan in reverse. For a card
 * rotated by `angle` around its center, transform the point into the card's
 * local (unrotated) frame, then do an axis-aligned bounds test.
 */
export function hitTestCard(
  cards: readonly CanvasCardRef[],
  point: { x: number; y: number }
): CanvasCardRef | null {
  for (let i = cards.length - 1; i >= 0; i--) {
    const c = cards[i]
    const cx = c.x + c.width / 2
    const cy = c.y + c.height / 2
    const cos = Math.cos(c.angle)
    const sin = Math.sin(c.angle)
    const dx = point.x - cx
    const dy = point.y - cy
    // Inverse rotation R(-angle) applied to (dx, dy), re-centered.
    const lx = cx + dx * cos + dy * sin
    const ly = cy - dx * sin + dy * cos
    if (lx >= c.x && lx <= c.x + c.width && ly >= c.y && ly <= c.y + c.height) {
      return c
    }
  }
  return null
}

/** Any non-selection Excalidraw tool means the user left the active card. */
export function shouldDeactivateForTool(activeToolType: string): boolean {
  return activeToolType !== 'selection'
}

export type ActiveAction =
  { type: 'activate'; id: string } | { type: 'deactivate' } | { type: 'cardGone'; id: string }

export function nextActive(prev: string | null, action: ActiveAction): string | null {
  switch (action.type) {
    case 'activate':
      return action.id
    case 'deactivate':
      return null
    case 'cardGone':
      return prev === action.id ? null : prev
  }
}

/**
 * The mounted set always includes the active card, so a stray recompute never
 * unmounts a live editor mid-edit.
 */
export function withActivePinned(
  visible: ReadonlySet<string>,
  activeCardId: string | null
): Set<string> {
  const next = new Set(visible)
  if (activeCardId) {
    next.add(activeCardId)
  }
  return next
}
