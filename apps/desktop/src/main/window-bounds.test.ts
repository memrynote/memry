import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  captureWindowState,
  createWindowBoundsPersister,
  resolveStartupBounds,
  WINDOW_BOUNDS_PERSIST_DELAY_MS,
  type DisplayLike,
  type SavedWindowBounds,
  type WindowStateSnapshot
} from './window-bounds'

const FALLBACK = { width: 1550, height: 900 }

// A single 1440x900 display whose work area starts at the origin.
const PRIMARY: DisplayLike = { workArea: { x: 0, y: 0, width: 1440, height: 900 } }

describe('resolveStartupBounds', () => {
  it('returns the fallback size, centered, when there are no saved bounds', () => {
    const result = resolveStartupBounds(null, [PRIMARY], FALLBACK)
    expect(result).toEqual({ width: 1550, height: 900, maximize: false, fullScreen: false })
    expect(result.x).toBeUndefined()
    expect(result.y).toBeUndefined()
  })

  it('restores saved size and position that sit on a display', () => {
    const saved: SavedWindowBounds = { width: 1200, height: 800, x: 100, y: 60 }
    expect(resolveStartupBounds(saved, [PRIMARY], FALLBACK)).toEqual({
      width: 1200,
      height: 800,
      x: 100,
      y: 60,
      maximize: false,
      fullScreen: false
    })
  })

  it('drops an off-screen position but keeps the saved size', () => {
    // x=5000 is far past the only 1440-wide display → not visible.
    const saved: SavedWindowBounds = { width: 1200, height: 800, x: 5000, y: 60 }
    const result = resolveStartupBounds(saved, [PRIMARY], FALLBACK)
    expect(result.width).toBe(1200)
    expect(result.height).toBe(800)
    expect(result.x).toBeUndefined()
    expect(result.y).toBeUndefined()
    expect(result.maximize).toBe(false)
  })

  it('passes through the maximized flag while keeping the normal bounds', () => {
    const saved: SavedWindowBounds = { width: 1200, height: 800, x: 100, y: 60, isMaximized: true }
    expect(resolveStartupBounds(saved, [PRIMARY], FALLBACK)).toEqual({
      width: 1200,
      height: 800,
      x: 100,
      y: 60,
      maximize: true,
      fullScreen: false
    })
  })

  it('passes through the fullscreen flag while keeping the normal bounds', () => {
    const saved: SavedWindowBounds = {
      width: 1200,
      height: 800,
      x: 100,
      y: 60,
      isFullScreen: true
    }
    expect(resolveStartupBounds(saved, [PRIMARY], FALLBACK)).toEqual({
      width: 1200,
      height: 800,
      x: 100,
      y: 60,
      maximize: false,
      fullScreen: true
    })
  })

  it('keeps the size when a position was never saved', () => {
    const saved: SavedWindowBounds = { width: 1300, height: 850 }
    const result = resolveStartupBounds(saved, [PRIMARY], FALLBACK)
    expect(result.width).toBe(1300)
    expect(result.height).toBe(850)
    expect(result.x).toBeUndefined()
    expect(result.y).toBeUndefined()
  })

  it('accepts a position on a secondary display to the right of the primary', () => {
    const secondary: DisplayLike = { workArea: { x: 1440, y: 0, width: 1920, height: 1080 } }
    const saved: SavedWindowBounds = { width: 1000, height: 700, x: 1600, y: 120 }
    expect(resolveStartupBounds(saved, [PRIMARY, secondary], FALLBACK)).toMatchObject({
      x: 1600,
      y: 120
    })
  })

  it('drops an absurdly small saved size in favour of the fallback', () => {
    const saved: SavedWindowBounds = { width: 20, height: 10, x: 100, y: 60 }
    const result = resolveStartupBounds(saved, [PRIMARY], FALLBACK)
    expect(result.width).toBe(FALLBACK.width)
    expect(result.height).toBe(FALLBACK.height)
  })
})

describe('captureWindowState', () => {
  const BASE: WindowStateSnapshot = {
    isDestroyed: false,
    isMinimized: false,
    isVisible: true,
    isMaximized: false,
    isFullScreen: false,
    bounds: { x: 100, y: 60, width: 1200, height: 800 },
    normalBounds: { x: 100, y: 60, width: 1200, height: 800 }
  }

  it('records the live bounds of a normal window', () => {
    expect(captureWindowState(BASE)).toEqual({
      width: 1200,
      height: 800,
      x: 100,
      y: 60,
      isMaximized: false,
      isFullScreen: false
    })
  })

  it('records the maximized flag with the normal (restore) bounds', () => {
    const state = captureWindowState({
      ...BASE,
      isMaximized: true,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 }
    })
    expect(state).toEqual({
      width: 1200,
      height: 800,
      x: 100,
      y: 60,
      isMaximized: true,
      isFullScreen: false
    })
  })

  it('records the fullscreen flag with the normal (restore) bounds', () => {
    const state = captureWindowState({
      ...BASE,
      isFullScreen: true,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 }
    })
    expect(state?.isFullScreen).toBe(true)
    expect(state).toMatchObject({ width: 1200, height: 800 })
  })

  // The reported bug (#2208): on Windows a hidden/minimized window answers
  // isMaximized() with false and hands back the restored rectangle, so capturing
  // then would downgrade the saved state and reopen the app small.
  it('skips a minimized window so the maximized state is not downgraded', () => {
    expect(captureWindowState({ ...BASE, isMinimized: true, isMaximized: false })).toBeNull()
  })

  it('skips a hidden window (tray) so the maximized state is not downgraded', () => {
    expect(captureWindowState({ ...BASE, isVisible: false, isMaximized: false })).toBeNull()
  })

  it('skips a destroyed window', () => {
    expect(captureWindowState({ ...BASE, isDestroyed: true })).toBeNull()
  })
})

describe('createWindowBoundsPersister', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Collects every persisted geometry, standing in for the config-file write. */
  function trackWrites(): {
    writes: SavedWindowBounds[]
    write: (bounds: SavedWindowBounds) => void
  } {
    const writes: SavedWindowBounds[] = []
    return { writes, write: (bounds) => void writes.push(bounds) }
  }

  it('writes once for a continuous 5 s drag gesture', () => {
    const { writes, write } = trackWrites()
    let x = 100
    const persister = createWindowBoundsPersister({
      read: () => ({ width: 1200, height: 800, x, y: 60, isMaximized: false }),
      write
    })

    // Electron emits `move` far faster than the debounce during a real drag.
    for (let elapsed = 0; elapsed < 5000; elapsed += 16) {
      x += 1
      persister.schedule()
      vi.advanceTimersByTime(16)
    }
    expect(writes).toHaveLength(0)

    vi.advanceTimersByTime(WINDOW_BOUNDS_PERSIST_DELAY_MS)
    expect(writes).toHaveLength(1)
    expect(writes[0].x).toBe(x)
  })

  it('rides out the mid-gesture stalls a 400 ms debounce would write through', () => {
    const { writes, write } = trackWrites()
    let x = 100
    const persister = createWindowBoundsPersister({
      read: () => ({ width: 1200, height: 800, x, y: 60, isMaximized: false }),
      write
    })

    // Drags stall — the pointer pauses, or the compositor coalesces events. Each
    // stall here outlasts the old 400 ms debounce but not the current one, so the
    // gesture must still settle into a single write.
    for (let step = 0; step < 5; step += 1) {
      x += 20
      persister.schedule()
      vi.advanceTimersByTime(600)
    }
    expect(writes).toHaveLength(0)

    vi.advanceTimersByTime(WINDOW_BOUNDS_PERSIST_DELAY_MS)
    expect(writes).toHaveLength(1)
  })

  it('debounces maximize instead of writing immediately', () => {
    const { writes, write } = trackWrites()
    let isMaximized = false
    const persister = createWindowBoundsPersister({
      read: () => ({ width: 1200, height: 800, x: 100, y: 60, isMaximized }),
      write
    })

    // Electron fires `resize` alongside `maximize`; both share the one timer now.
    isMaximized = true
    persister.schedule()
    persister.schedule()
    expect(writes).toHaveLength(0)

    vi.advanceTimersByTime(WINDOW_BOUNDS_PERSIST_DELAY_MS)
    expect(writes).toEqual([{ width: 1200, height: 800, x: 100, y: 60, isMaximized: true }])
  })

  it('skips the write when the geometry is unchanged since the last one', () => {
    const { writes, write } = trackWrites()
    const persister = createWindowBoundsPersister({
      read: () => ({ width: 1200, height: 800, x: 100, y: 60, isMaximized: false }),
      write
    })

    persister.schedule()
    vi.advanceTimersByTime(WINDOW_BOUNDS_PERSIST_DELAY_MS)
    expect(writes).toHaveLength(1)

    // A window nudged and snapped back re-emits `move` with identical geometry.
    persister.schedule()
    vi.advanceTimersByTime(WINDOW_BOUNDS_PERSIST_DELAY_MS)
    persister.flush()
    expect(writes).toHaveLength(1)
  })

  // #2208: the tray hides the window before `close`, so the close flush reads an
  // untrustworthy snapshot (read() returns null) and must leave the maximized
  // state written at hide time alone.
  it('keeps the last state when a later flush has nothing trustworthy to read', () => {
    const { writes, write } = trackWrites()
    let visible = true
    const persister = createWindowBoundsPersister({
      read: () => (visible ? { width: 1200, height: 800, x: 100, y: 60, isMaximized: true } : null),
      write
    })

    // `hide` flushes the real maximized state...
    persister.flush()
    expect(writes).toEqual([{ width: 1200, height: 800, x: 100, y: 60, isMaximized: true }])

    // ...then `close` fires on the already-hidden window and writes nothing.
    visible = false
    persister.flush()
    expect(writes).toHaveLength(1)
  })

  it('flushes the pending geometry once on close and cancels the timer', () => {
    const { writes, write } = trackWrites()
    const persister = createWindowBoundsPersister({
      read: () => ({ width: 1000, height: 700, x: 10, y: 20, isMaximized: false }),
      write
    })

    persister.schedule()
    persister.flush()
    expect(writes).toHaveLength(1)

    // The cancelled timer must not land a second, redundant write.
    vi.advanceTimersByTime(WINDOW_BOUNDS_PERSIST_DELAY_MS * 2)
    expect(writes).toHaveLength(1)
  })

  it('writes nothing when there is no geometry worth remembering', () => {
    const { writes, write } = trackWrites()
    const persister = createWindowBoundsPersister({ read: () => null, write })

    persister.schedule()
    vi.advanceTimersByTime(WINDOW_BOUNDS_PERSIST_DELAY_MS)
    persister.flush()
    expect(writes).toHaveLength(0)
  })
})
