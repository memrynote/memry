/**
 * Pure helpers for restoring the main window to its last size/position.
 *
 * Kept free of Electron imports so the on-screen validation logic can be unit
 * tested without a display server. `index.ts` feeds it `screen.getAllDisplays()`
 * and the persisted bounds from the store.
 */

export interface SavedWindowBounds {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized?: boolean
}

/** Shape of the parts of an Electron `Display` we depend on. */
export interface DisplayLike {
  workArea: { x: number; y: number; width: number; height: number }
}

export interface ResolvedBounds {
  width: number
  height: number
  x?: number
  y?: number
  maximize: boolean
}

// Sizes below this are almost certainly corrupt/stale and would produce an
// unusable window, so we fall back to the default size instead.
const MIN_WIDTH = 400
const MIN_HEIGHT = 300

// A saved position is only reused if at least this much of the window would land
// on a connected display's work area — otherwise the window would open off-screen
// (e.g. a monitor that has since been unplugged).
const MIN_VISIBLE_X = 100
const MIN_VISIBLE_Y = 50

function isPositionVisible(
  x: number,
  y: number,
  width: number,
  height: number,
  displays: DisplayLike[]
): boolean {
  return displays.some(({ workArea }) => {
    const overlapX = Math.min(x + width, workArea.x + workArea.width) - Math.max(x, workArea.x)
    const overlapY = Math.min(y + height, workArea.y + workArea.height) - Math.max(y, workArea.y)
    return overlapX >= MIN_VISIBLE_X && overlapY >= MIN_VISIBLE_Y
  })
}

/**
 * Decide how to open the main window given the previously saved bounds.
 *
 * - No (or corrupt) saved bounds → the fallback size, centered by the OS.
 * - A saved position is only reused when it remains visible on some display.
 * - The maximized flag is passed through; the returned size is the *normal*
 *   (un-maximized) size so a later `unmaximize()` restores it correctly.
 */
export function resolveStartupBounds(
  saved: SavedWindowBounds | null,
  displays: DisplayLike[],
  fallback: { width: number; height: number }
): ResolvedBounds {
  const hasValidSize = saved != null && saved.width >= MIN_WIDTH && saved.height >= MIN_HEIGHT
  if (!hasValidSize) {
    return { width: fallback.width, height: fallback.height, maximize: false }
  }

  const result: ResolvedBounds = {
    width: saved.width,
    height: saved.height,
    maximize: saved.isMaximized === true
  }

  if (
    saved.x !== undefined &&
    saved.y !== undefined &&
    isPositionVisible(saved.x, saved.y, saved.width, saved.height, displays)
  ) {
    result.x = saved.x
    result.y = saved.y
  }

  return result
}
