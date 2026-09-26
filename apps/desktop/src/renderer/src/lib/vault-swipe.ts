/**
 * Sidebar vault swipe: the gesture math, kept free of React and the DOM so it
 * can be tested against recorded wheel streams.
 *
 * A two-finger horizontal trackpad scroll arrives as a stream of `wheel`
 * events: finger movement first, then (on macOS) a decaying momentum tail, and
 * no event at all when the fingers lift. So "release" is an idle gap, and the
 * momentum tail is what turns a flick into distance.
 *
 * Offsets are physical pixels: negative moves the list toward the left edge.
 * Which vault that reveals depends on reading direction (`neighborIndex`).
 */

export const VAULT_SWIPE = {
  /** Movement needed before the gesture picks an axis. */
  axisLockPx: 8,
  /** Horizontal wins only when it clearly dominates, so list scrolling never switches vaults. */
  axisRatio: 1.5,
  /** Fraction of the pane width past which releasing commits. */
  commitRatio: 0.35,
  /** Peak speed toward the target (px/ms) that commits a short, fast flick. */
  flingVelocity: 0.5,
  /** Resistance past the first or last vault. */
  rubberBand: 0.3,
  /** No wheel event for this long means the fingers (and momentum) stopped. */
  idleMs: 120
} as const

export type SwipePhase = 'idle' | 'deciding' | 'tracking' | 'ignoring'

export interface SwipeState {
  phase: SwipePhase
  accX: number
  accY: number
  /** Unresisted offset in px, clamped to the pane width. */
  rawOffset: number
  /** Fastest recent speed in the direction of `rawOffset`, px/ms. */
  peakVelocity: number
  lastTime: number
}

export const INITIAL_SWIPE: SwipeState = {
  phase: 'idle',
  accX: 0,
  accY: 0,
  rawOffset: 0,
  peakVelocity: 0,
  lastTime: 0
}

export interface SwipeContext {
  width: number
  /** Whether a vault exists on the side a given offset sign reveals. */
  hasTarget: (sign: -1 | 1) => boolean
}

export interface WheelSample {
  dx: number
  dy: number
  time: number
}

function signOf(value: number): -1 | 0 | 1 {
  return value > 0 ? 1 : value < 0 ? -1 : 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function applyWheel(state: SwipeState, sample: WheelSample, ctx: SwipeContext): SwipeState {
  switch (state.phase) {
    case 'ignoring':
      return { ...state, lastTime: sample.time }

    case 'idle':
    case 'deciding': {
      const accX = state.accX + sample.dx
      const accY = state.accY + sample.dy
      const absX = Math.abs(accX)
      const absY = Math.abs(accY)
      if (Math.max(absX, absY) < VAULT_SWIPE.axisLockPx) {
        return { ...INITIAL_SWIPE, phase: 'deciding', accX, accY, lastTime: sample.time }
      }
      if (absX <= VAULT_SWIPE.axisRatio * absY) {
        return { ...INITIAL_SWIPE, phase: 'ignoring', lastTime: sample.time }
      }
      return {
        ...INITIAL_SWIPE,
        phase: 'tracking',
        accX,
        accY,
        rawOffset: clamp(-accX, -ctx.width, ctx.width),
        lastTime: sample.time
      }
    }

    case 'tracking': {
      const rawOffset = clamp(state.rawOffset - sample.dx, -ctx.width, ctx.width)
      const dt = Math.max(1, sample.time - state.lastTime)
      const velocity = -sample.dx / dt
      const direction = signOf(rawOffset)
      let peakVelocity = state.peakVelocity
      if (direction !== 0 && signOf(velocity) === direction) {
        if (Math.abs(velocity) > Math.abs(peakVelocity)) peakVelocity = velocity
      } else if (Math.abs(velocity) > 0.2) {
        // A deliberate move back cancels the flick that came before it.
        peakVelocity = 0
      }
      return { ...state, rawOffset, peakVelocity, lastTime: sample.time }
    }
  }
}

/** The offset to paint: resisted when there is no vault on that side. */
export function visualOffset(state: SwipeState, ctx: SwipeContext): number {
  const direction = signOf(state.rawOffset)
  if (direction === 0) return 0
  return ctx.hasTarget(direction) ? state.rawOffset : state.rawOffset * VAULT_SWIPE.rubberBand
}

/** 0..1 progress toward the vault being revealed; 0 when there is none. */
export function swipeProgress(state: SwipeState, ctx: SwipeContext): number {
  const direction = signOf(state.rawOffset)
  if (direction === 0 || !ctx.hasTarget(direction) || ctx.width <= 0) return 0
  return clamp(Math.abs(state.rawOffset) / ctx.width, 0, 1)
}

/** The list reached the far edge: commit without waiting for momentum to die. */
export function reachedFullWidth(state: SwipeState, ctx: SwipeContext): boolean {
  const direction = signOf(state.rawOffset)
  return (
    state.phase === 'tracking' &&
    direction !== 0 &&
    ctx.hasTarget(direction) &&
    Math.abs(state.rawOffset) >= ctx.width
  )
}

export function resolveRelease(state: SwipeState, ctx: SwipeContext): 'commit' | 'cancel' {
  if (state.phase !== 'tracking') return 'cancel'
  const direction = signOf(state.rawOffset)
  if (direction === 0 || !ctx.hasTarget(direction)) return 'cancel'
  if (Math.abs(state.rawOffset) >= VAULT_SWIPE.commitRatio * ctx.width) return 'commit'
  if (state.peakVelocity * direction >= VAULT_SWIPE.flingVelocity) return 'commit'
  return 'cancel'
}

/**
 * The vault an offset sign reveals. Moving the list toward the left edge shows
 * what lies to the right: the next vault in LTR, the previous one in RTL.
 */
export function neighborIndex(
  activeIndex: number,
  sign: -1 | 1,
  isRtl: boolean,
  count: number
): number | null {
  const step = (sign === -1) !== isRtl ? 1 : -1
  const index = activeIndex + step
  return activeIndex >= 0 && index >= 0 && index < count ? index : null
}

/**
 * Which vaults the footer indicator shows. At most `max` slots, the window
 * following the active vault; an edge with more vaults beyond it is marked so
 * the dot there can shrink.
 */
export function indicatorWindow(
  count: number,
  activeIndex: number,
  max = 5
): { start: number; end: number; moreBefore: boolean; moreAfter: boolean } {
  if (count <= max) return { start: 0, end: count, moreBefore: false, moreAfter: false }
  const start = clamp(activeIndex - Math.floor(max / 2), 0, count - max)
  const end = start + max
  return { start, end, moreBefore: start > 0, moreAfter: end < count }
}
