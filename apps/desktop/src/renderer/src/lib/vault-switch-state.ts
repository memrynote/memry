/**
 * In-app vault switch state
 *
 * A switch closes one vault and opens another, and main reports the gap as
 * `isOpen: false`. Without this store the renderer cannot tell that gap from
 * "no vault at all", so every switch flashed the onboarding screen and the new
 * vault's tabs were restored as if the app had just been launched.
 *
 * Module-level (not React context) because the switch outlives the tree that
 * starts it: the sidebar that begins a swipe is unmounted before the switch
 * resolves, and the tree that reads the result mounts after.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react'

/** Which way the user moved through the vault order. */
export type VaultSwitchDirection = 'next' | 'prev'

export interface VaultSwitchTarget {
  path: string
  name: string
  accentColor?: string
}

export interface VaultSwitchState {
  /** Set while main closes the old vault and opens `pending.path`. */
  pending: VaultSwitchTarget | null
  /**
   * The last vault entered through an in-app switch. Kept until the next
   * switch starts, so the tree that mounts for it can tell a switch from a
   * cold start without racing a one-shot flag.
   */
  arrival: { path: string; direction: VaultSwitchDirection | null } | null
}

let state: VaultSwitchState = { pending: null, arrival: null }
/** See `setVaultSwitchFrame`. */
let switchFrame: string | null = null
const listeners = new Set<() => void>()

function setState(next: VaultSwitchState): void {
  state = next
  for (const listener of [...listeners]) listener()
}

export function subscribeVaultSwitchState(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getVaultSwitchState(): VaultSwitchState {
  return state
}

export function useVaultSwitchState(): VaultSwitchState {
  return useSyncExternalStore(subscribeVaultSwitchState, getVaultSwitchState, getVaultSwitchState)
}

export function beginVaultSwitch(
  target: VaultSwitchTarget,
  direction: VaultSwitchDirection | null
): void {
  setState({ pending: target, arrival: { path: target.path, direction } })
}

/**
 * The switch settled. `arrival` survives a success so the incoming tree can
 * read it; a failure drops it, because the vault it names never opened.
 */
export function endVaultSwitch(success: boolean): void {
  switchFrame = null
  setState({ pending: null, arrival: success ? state.arrival : null })
}

/**
 * The sidebar as it looked when the pager finished its move, serialized. The
 * switch screen paints it for the gap between the two vaults, so the sidebar
 * holds still instead of dropping to an empty column. Set just before the
 * switch starts, cleared when it ends; switches not started by the pager have
 * no frame.
 */
export function setVaultSwitchFrame(html: string | null): void {
  switchFrame = html
}

export function getVaultSwitchFrame(): string | null {
  return switchFrame
}

/**
 * Holds the reveal of the incoming vault. The pager starts the switch as soon
 * as the gesture commits, so main swaps vaults while the settle animation
 * plays; a fast switch would otherwise swap the workspace mid-animation. While
 * a hold is out, `useVault` buffers status changes and applies the latest one
 * when the last hold is released. Returns the release; calling it twice is a
 * no-op.
 */
let revealHolds = 0

export function holdVaultReveal(): () => void {
  revealHolds += 1
  let released = false
  return () => {
    if (released) return
    released = true
    revealHolds -= 1
    if (revealHolds === 0) for (const listener of [...listeners]) listener()
  }
}

export function isVaultRevealHeld(): boolean {
  return revealHolds > 0
}

/** Whether `vaultPath` was entered through an in-app switch. */
export function wasEnteredBySwitch(vaultPath: string | null): boolean {
  return vaultPath !== null && state.arrival?.path === vaultPath
}

/** Test-only reset. */
export function resetVaultSwitchState(): void {
  switchFrame = null
  revealHolds = 0
  setState({ pending: null, arrival: null })
}

// =============================================================================
// Live swipe progress
// =============================================================================

/**
 * The pager (sidebar content) and the indicator (sidebar footer) render in
 * different subtrees but move on one progress value, so nothing animates on its
 * own clock. Published at most once per animation frame.
 */
export interface VaultSwipeProgress {
  /** Vault the gesture is heading toward, or null at rest. */
  targetPath: string | null
  /** 0 at rest, 1 when the target fully replaces the current vault. */
  progress: number
}

const REST: VaultSwipeProgress = { targetPath: null, progress: 0 }
let swipe: VaultSwipeProgress = REST
const swipeListeners = new Set<() => void>()

export function setVaultSwipeProgress(targetPath: string | null, progress: number): void {
  const next = targetPath === null || progress <= 0 ? REST : { targetPath, progress }
  if (next.targetPath === swipe.targetPath && next.progress === swipe.progress) return
  swipe = next
  for (const listener of [...swipeListeners]) listener()
}

function subscribeSwipe(listener: () => void): () => void {
  swipeListeners.add(listener)
  return () => {
    swipeListeners.delete(listener)
  }
}

function getSwipe(): VaultSwipeProgress {
  return swipe
}

export function useVaultSwipeProgress(): VaultSwipeProgress {
  return useSyncExternalStore(subscribeSwipe, getSwipe, getSwipe)
}

// =============================================================================
// Page requests
// =============================================================================

/**
 * A click on an indicator dot or the next/previous-vault shortcut asks the
 * pager to move, so every way of switching from the sidebar plays the same
 * transition through one owner.
 */
export type VaultPageRequest = { path: string } | { step: 1 | -1 }

const pageListeners = new Set<(request: VaultPageRequest) => void>()

export function requestVaultPage(request: VaultPageRequest): void {
  for (const listener of [...pageListeners]) listener(request)
}

export function useVaultPageRequest(onRequest: (request: VaultPageRequest) => void): void {
  const handlerRef = useRef(onRequest)

  useEffect(() => {
    handlerRef.current = onRequest
  }, [onRequest])

  useEffect(() => {
    const listener = (request: VaultPageRequest): void => handlerRef.current(request)
    pageListeners.add(listener)
    return () => {
      pageListeners.delete(listener)
    }
  }, [])
}
