import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { VaultInfo } from '../../../../preload/index.d'
import { VaultTitleRow, resolveVaultAccent } from '@/components/sidebar/vault-title-row'
import {
  INITIAL_SWIPE,
  applyWheel,
  neighborIndex,
  reachedFullWidth,
  resolveRelease,
  swipeProgress,
  visualOffset,
  VAULT_SWIPE,
  type SwipeContext,
  type SwipeState
} from '@/lib/vault-swipe'
import {
  getVaultSwitchState,
  holdVaultReveal,
  requestVaultPage,
  setVaultSwipeProgress,
  setVaultSwitchFrame,
  subscribeVaultSwitchState,
  useVaultPageRequest,
  type VaultPageRequest,
  type VaultSwitchDirection,
  type VaultSwitchState
} from '@/lib/vault-switch-state'
import {
  captureVaultSidebarSnapshot,
  getVaultSidebarSnapshot,
  serializeSidebarSnapshot,
  vaultTintStyle
} from '@/lib/vault-sidebar-snapshot'
import { useShortcutBinding } from '@/lib/shortcut-bindings'
import { matchesShortcut } from '@/hooks/use-keyboard-shortcuts-base'
import { isPlainTextInputFocused } from '@/hooks/use-keyboard-shortcuts'

/** Motion values from DESIGN.md: settle is `--duration-slow`, cancel `--duration-normal`. */
const SETTLE_MS = 300
/** A release late in the gesture only finishes the remaining distance, never slower than this. */
const MIN_SETTLE_MS = 140
const CANCEL_MS = 200
const REDUCED_MS = 150
const ENTER_MS = 200
const ENTER_SHIFT_PX = 24
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'
const EASE_IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)'
/** How far the outgoing list dims at full travel; it never disappears mid-gesture. */
const TRACK_DIM = 0.4
/** Space between two vault pages while both are on screen. */
const PAGE_GAP_PX = 24
/** The arrival snapshot fades once the new vault's queries settle, or after this at most. */
const ARRIVAL_MAX_MS = 800
const REVEAL_MS = 150
/** A freshly opened vault is snapshotted once its sidebar has had time to load. */
const SNAPSHOT_IDLE_MS = 1500

/**
 * The arrival whose snapshot was already shown. The pager can remount inside
 * one open vault; the cover belongs to the switch, not to every mount.
 */
let coveredArrival: VaultSwitchState['arrival'] = null

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

/**
 * Animate between two style frames and resolve when done. jsdom (and any
 * engine without the Web Animations API) jumps straight to the end state.
 */
function animateTo(
  el: HTMLElement | null,
  from: Keyframe,
  to: Keyframe,
  duration: number,
  easing: string
): Promise<void> {
  if (!el) return Promise.resolve()
  const apply = (): void => {
    el.style.transform = typeof to.transform === 'string' ? to.transform : ''
    el.style.opacity = to.opacity === undefined ? '' : String(to.opacity)
  }
  if (typeof el.animate !== 'function') {
    apply()
    return Promise.resolve()
  }
  const animation = el.animate([from, to], { duration, easing, fill: 'forwards' })
  return animation.finished
    .then(() => {
      apply()
      animation.cancel()
    })
    .catch(() => apply())
}

/**
 * Play the commit settle: the list leaves toward `exitSign` and the target
 * page slides into place (a crossfade under reduced motion). `fromOffset` is
 * where the gesture was released, 0 for clicks and shortcuts.
 */
async function settleTo(
  track: HTMLElement,
  peek: HTMLElement,
  fromOffset: number,
  exitSign: number,
  width: number
): Promise<void> {
  if (prefersReducedMotion()) {
    await Promise.all([
      animateTo(
        track,
        { opacity: track.style.opacity || '1' },
        { opacity: 0 },
        REDUCED_MS,
        'linear'
      ),
      animateTo(peek, { opacity: peek.style.opacity || '0' }, { opacity: 1 }, REDUCED_MS, 'linear')
    ])
    return
  }
  const pageStep = width + PAGE_GAP_PX
  const peekFrom = fromOffset - exitSign * pageStep
  const easing = fromOffset !== 0 ? EASE_OUT : EASE_IN_OUT
  // A release past halfway only has the rest of the distance to cover.
  const travelled = Math.min(1, Math.abs(fromOffset) / (width || 1))
  const settleMs = Math.max(MIN_SETTLE_MS, Math.round(SETTLE_MS * (1 - travelled)))
  await Promise.all([
    animateTo(
      track,
      {
        transform: `translateX(${fromOffset}px)`,
        opacity: 1 - TRACK_DIM * (Math.abs(fromOffset) / (width || 1))
      },
      { transform: `translateX(${exitSign * pageStep}px)`, opacity: 1 - TRACK_DIM },
      settleMs,
      easing
    ),
    animateTo(
      peek,
      { transform: `translateX(${peekFrom}px)`, opacity: 1 },
      { transform: 'translateX(0px)', opacity: 1 },
      settleMs,
      easing
    )
  ])
}

interface VaultPagerProps {
  /** Switchable vaults in the user's order, including the open one. */
  vaults: VaultInfo[]
  activePath: string
  activeName: string
  /** Performs the switch; resolves false when it failed and the list must return. */
  onSwitch: (vault: VaultInfo, direction: VaultSwitchDirection) => Promise<boolean>
  children: ReactNode
}

/**
 * The sidebar list as one page of a horizontal strip of vaults. A two-finger
 * horizontal swipe drags it and the neighbouring vault's page follows it in.
 *
 * Only the open vault has live data, so the neighbour's page is the sidebar it
 * drew when it was last open (see `vault-sidebar-snapshot`), falling back to
 * its name for a vault never opened here. The same snapshot covers the list
 * right after a switch until the new vault's queries have loaded, so the page
 * the user swiped to is the page they land on.
 */
export function VaultPager({
  vaults,
  activePath,
  activeName,
  onSwitch,
  children
}: VaultPagerProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const peekRef = useRef<HTMLDivElement>(null)
  const swipeRef = useRef<SwipeState>(INITIAL_SWIPE)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameRef = useRef<number | null>(null)
  /** Set while a settle animation or the switch itself runs: input is swallowed. */
  const busyRef = useRef(false)
  const [peekIndex, setPeekIndex] = useState<number | null>(null)
  const peekIndexRef = useRef<number | null>(null)
  const coverRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()
  // Read once: the cover is for the switch that mounted this tree.
  const [cover, setCover] = useState<string | null>(() => {
    const arrival = getVaultSwitchState().arrival
    if (!arrival || arrival === coveredArrival || arrival.path !== activePath) return null
    return getVaultSidebarSnapshot(activePath)
  })
  const coveringRef = useRef(cover !== null)

  const activeIndex = vaults.findIndex((vault) => vault.path === activePath)
  const peekVault = peekIndex === null ? null : (vaults[peekIndex] ?? null)
  const peekSnapshot = peekVault ? getVaultSidebarSnapshot(peekVault.path) : null

  /** Record the open vault's list as its page for the next swipe toward it. */
  const captureSnapshot = useCallback(() => {
    const track = trackRef.current
    // Under the cover the list may still be loading; keep the last good page.
    if (!track || coveringRef.current) return
    captureVaultSidebarSnapshot(activePath, track)
  }, [activePath])

  /** Lift the arrival cover, animated unless a gesture needs the live list now. */
  const uncover = useCallback((animate: boolean) => {
    if (!coveringRef.current) return
    coveringRef.current = false
    const done = (): void => setCover(null)
    if (!animate || prefersReducedMotion()) {
      done()
      return
    }
    void animateTo(coverRef.current, { opacity: 1 }, { opacity: 0 }, REVEAL_MS, 'linear').then(done)
  }, [])

  const isRtl = useCallback((): boolean => {
    const el = viewportRef.current
    return el ? getComputedStyle(el).direction === 'rtl' : false
  }, [])

  const context = useCallback((): SwipeContext => {
    const width = viewportRef.current?.clientWidth ?? 0
    const rtl = isRtl()
    return {
      width,
      hasTarget: (sign) => neighborIndex(activeIndex, sign, rtl, vaults.length) !== null
    }
  }, [activeIndex, isRtl, vaults.length])

  const showPeek = useCallback((index: number | null) => {
    if (peekIndexRef.current === index) return
    peekIndexRef.current = index
    setPeekIndex(index)
  }, [])

  /** Paint the list and the peek for a physical offset and 0..1 progress. */
  const paint = useCallback((offset: number, progress: number, width: number) => {
    const track = trackRef.current
    const peek = peekRef.current
    if (!track || !peek) return
    if (prefersReducedMotion()) {
      // Reduced motion: nothing travels, the two names crossfade in place.
      track.style.transform = ''
      track.style.opacity = String(1 - progress)
      peek.style.transform = ''
      peek.style.opacity = String(progress)
      return
    }
    track.style.transform = offset === 0 ? '' : `translateX(${offset}px)`
    track.style.opacity = progress === 0 ? '' : String(1 - TRACK_DIM * progress)
    const peekOffset = offset < 0 ? offset + width + PAGE_GAP_PX : offset - width - PAGE_GAP_PX
    peek.style.transform = `translateX(${peekOffset}px)`
    peek.style.opacity = progress === 0 ? '0' : '1'
  }, [])

  const resetPaint = useCallback(() => {
    paint(0, 0, viewportRef.current?.clientWidth ?? 0)
    showPeek(null)
    setVaultSwipeProgress(null, 0)
  }, [paint, showPeek])

  /**
   * Finish a move toward `targetIndex` from the current offset, then switch.
   * `fromOffset` is 0 for clicks and shortcuts, which play the whole transition.
   */
  const commit = useCallback(
    async (targetIndex: number, fromOffset: number) => {
      const target = vaults[targetIndex]
      const track = trackRef.current
      const peek = peekRef.current
      const width = viewportRef.current?.clientWidth ?? 0
      if (!target || !track || !peek || busyRef.current) return
      busyRef.current = true
      uncover(false)
      showPeek(targetIndex)
      setVaultSwipeProgress(target.path, 1)

      const direction: VaultSwitchDirection = targetIndex > activeIndex ? 'next' : 'prev'
      // Physical side the list leaves toward: next leaves toward the start edge.
      const exitSign =
        fromOffset !== 0 ? Math.sign(fromOffset) : (direction === 'next') !== isRtl() ? -1 : 1

      // Main swaps vaults while the settle plays instead of after it, so most
      // of the switch is hidden behind the motion. The hold keeps the incoming
      // vault from being revealed before the page has landed.
      const releaseReveal = holdVaultReveal()
      const switching = onSwitch(target, direction)

      try {
        await settleTo(track, peek, fromOffset, exitSign, width)
      } finally {
        // Freeze the sidebar exactly as it now stands, target page in place,
        // for the switch screen should main still be between the two vaults.
        // A switch that already ended cleared the frame and must not get one.
        if (getVaultSwitchState().pending?.path === target.path) {
          const sidebar = viewportRef.current?.closest('[data-sidebar="sidebar"]')
          setVaultSwitchFrame(sidebar ? serializeSidebarSnapshot(sidebar) : null)
        }
        releaseReveal()
      }

      const switched = await switching
      // On success this tree is replaced by the next vault's. On failure the
      // list comes back so the user is never left on an empty pane.
      if (!switched) {
        setVaultSwitchFrame(null)
        busyRef.current = false
        resetPaint()
      }
    },
    [activeIndex, isRtl, onSwitch, resetPaint, showPeek, uncover, vaults]
  )

  const cancel = useCallback(
    async (fromOffset: number) => {
      const track = trackRef.current
      const peek = peekRef.current
      const width = viewportRef.current?.clientWidth ?? 0
      if (!track || !peek) return
      busyRef.current = true
      if (prefersReducedMotion() || fromOffset === 0) {
        resetPaint()
        busyRef.current = false
        return
      }
      const sign = Math.sign(fromOffset)
      await Promise.all([
        animateTo(
          track,
          { transform: `translateX(${fromOffset}px)` },
          { transform: 'translateX(0px)', opacity: 1 },
          CANCEL_MS,
          EASE_OUT
        ),
        animateTo(
          peek,
          { transform: `translateX(${fromOffset - sign * (width + PAGE_GAP_PX)}px)` },
          { transform: `translateX(${-sign * (width + PAGE_GAP_PX)}px)`, opacity: 0 },
          CANCEL_MS,
          EASE_OUT
        )
      ])
      resetPaint()
      busyRef.current = false
    },
    [resetPaint]
  )

  const release = useCallback(() => {
    const state = swipeRef.current
    const ctx = context()
    const offset = visualOffset(state, ctx)
    // Anything still arriving is momentum from this gesture, not a new one.
    swipeRef.current = { ...INITIAL_SWIPE, phase: 'ignoring', lastTime: state.lastTime }
    if (resolveRelease(state, ctx) === 'commit') {
      const sign = offset < 0 ? -1 : 1
      const target = neighborIndex(activeIndex, sign, isRtl(), vaults.length)
      if (target !== null) {
        void commit(target, offset)
        return
      }
    }
    void cancel(offset)
  }, [activeIndex, cancel, commit, context, isRtl, vaults.length])

  // Wheel listener: native and non-passive, since a tracked gesture must stop
  // the browser from also scrolling.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const onIdle = (): void => {
      idleTimerRef.current = null
      if (swipeRef.current.phase === 'tracking' && !busyRef.current) {
        release()
        return
      }
      swipeRef.current = INITIAL_SWIPE
    }

    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.deltaMode !== 0) return
      if (vaults.length < 2 || activeIndex < 0) return

      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      idleTimerRef.current = setTimeout(onIdle, VAULT_SWIPE.idleMs)

      if (busyRef.current) {
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) event.preventDefault()
        return
      }

      const ctx = context()
      const previousPhase = swipeRef.current.phase
      const next = applyWheel(
        swipeRef.current,
        { dx: event.deltaX, dy: event.deltaY, time: event.timeStamp },
        ctx
      )
      swipeRef.current = next
      if (next.phase !== 'tracking') return
      if (previousPhase !== 'tracking') {
        // The list is at rest right up to this event: the freshest page to keep.
        uncover(false)
        captureSnapshot()
      }

      event.preventDefault()
      const offset = visualOffset(next, ctx)
      const sign = offset < 0 ? -1 : 1
      const target = offset === 0 ? null : neighborIndex(activeIndex, sign, isRtl(), vaults.length)
      showPeek(target)

      if (reachedFullWidth(next, ctx)) {
        release()
        return
      }

      if (frameRef.current !== null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        const current = swipeRef.current
        if (current.phase !== 'tracking' || busyRef.current) return
        const latestCtx = context()
        const latestOffset = visualOffset(current, latestCtx)
        const progress = swipeProgress(current, latestCtx)
        paint(latestOffset, progress, latestCtx.width)
        const latestTarget =
          latestOffset === 0
            ? null
            : neighborIndex(activeIndex, latestOffset < 0 ? -1 : 1, isRtl(), vaults.length)
        setVaultSwipeProgress(latestTarget === null ? null : vaults[latestTarget].path, progress)
      })
    }

    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      viewport.removeEventListener('wheel', onWheel)
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [activeIndex, captureSnapshot, context, isRtl, paint, release, showPeek, uncover, vaults])

  // Indicator clicks and the next/previous shortcuts play the same transition.
  useVaultPageRequest(
    useCallback(
      (request: VaultPageRequest) => {
        if (busyRef.current || activeIndex < 0) return
        const targetIndex =
          'path' in request
            ? vaults.findIndex((vault) => vault.path === request.path)
            : activeIndex + request.step
        if (targetIndex < 0 || targetIndex >= vaults.length || targetIndex === activeIndex) return
        void commit(targetIndex, 0)
      },
      [activeIndex, commit, vaults]
    )
  )

  useAdjacentVaultShortcuts()

  // Arriving under a cover: lift it once the new vault's queries have settled.
  // The cover is pointer-transparent, so the live list is usable underneath.
  useEffect(() => {
    if (!coveringRef.current) return
    coveredArrival = getVaultSwitchState().arrival
    // Checking starts two frames in: the list's queries start in its own mount
    // effects, and an empty fetch count before that means nothing.
    let ready = false
    const check = (): void => {
      if (ready && queryClient.isFetching() === 0) uncover(true)
    }
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        ready = true
        check()
      })
    })
    const timer = setTimeout(() => uncover(true), ARRIVAL_MAX_MS)
    const unsubscribe = queryClient.getQueryCache().subscribe(check)
    return () => {
      unsubscribe()
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
    // Mount-only: the cover is for the switch that mounted this tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep this vault's page current: once the list has loaded, and whenever a
  // switch away starts (from here or from the vault menu), or the window goes.
  useEffect(() => {
    const timer = setTimeout(captureSnapshot, SNAPSHOT_IDLE_MS)
    window.addEventListener('pagehide', captureSnapshot)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pagehide', captureSnapshot)
    }
  }, [captureSnapshot])

  useEffect(
    () =>
      subscribeVaultSwitchState(() => {
        const { pending } = getVaultSwitchState()
        if (pending && pending.path !== activePath) captureSnapshot()
      }),
    [activePath, captureSnapshot]
  )

  // The workspace is kept mounted (hidden) after a switch away, and a commit
  // leaves this pager mid-move: list slid out, neighbour's page in place, input
  // swallowed. Layout effects re-run when the workspace is revealed again, so
  // put the list back before that first frame paints.
  useLayoutEffect(() => {
    if (!busyRef.current) return
    busyRef.current = false
    swipeRef.current = INITIAL_SWIPE
    resetPaint()
  }, [resetPaint])

  // Entering through a switch: the list settles in from the side it came from.
  // Only for the switch that mounted this tree (a revealed workspace is already
  // in place), and not under a cover, which already put the page there.
  const [mountArrival] = useState(() => getVaultSwitchState().arrival)
  useEffect(() => {
    const arrival = getVaultSwitchState().arrival
    const track = trackRef.current
    if (!track || !arrival || arrival.path !== activePath || !arrival.direction) return
    if (arrival !== mountArrival || coveringRef.current) return
    if (prefersReducedMotion()) {
      void animateTo(track, { opacity: 0 }, { opacity: 1 }, REDUCED_MS, 'linear')
      return
    }
    // Next arrives from the end edge (right in LTR), previous from the start.
    const endSign = isRtl() ? -1 : 1
    const shift = (arrival.direction === 'next' ? endSign : -endSign) * ENTER_SHIFT_PX
    void animateTo(
      track,
      { transform: `translateX(${shift}px)`, opacity: 0 },
      { transform: 'translateX(0px)', opacity: 1 },
      ENTER_MS,
      EASE_OUT
    )
    // Mount-only (and re-run on reveal, where the arrival check skips it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => setVaultSwipeProgress(null, 0), [])

  return (
    <div ref={viewportRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div ref={trackRef} className="relative flex min-h-0 flex-1 flex-col">
        <VaultTitleRow name={activeName} dotColor="var(--tint)" className="pt-2" />
        {children}
        {cover !== null && (
          // Inside the track so a swipe that starts under it carries it along.
          <div
            ref={coverRef}
            aria-hidden="true"
            inert
            data-testid="vault-pager-cover"
            data-snapshot-exclude=""
            className="pointer-events-none absolute inset-0 flex flex-col overflow-hidden bg-sidebar"
            // The live theme may still carry the previous vault's accent.
            style={vaultTintStyle(resolveVaultAccent(vaults[activeIndex]?.accentColor))}
            dangerouslySetInnerHTML={{ __html: cover }}
          />
        )}
      </div>
      <div
        ref={peekRef}
        aria-hidden="true"
        inert
        data-testid="vault-pager-peek"
        className="pointer-events-none absolute inset-0 flex flex-col overflow-hidden"
        style={{
          ...(peekVault ? vaultTintStyle(resolveVaultAccent(peekVault.accentColor)) : null),
          opacity: 0
        }}
      >
        {peekVault &&
          (peekSnapshot ? (
            <div
              className="flex min-h-0 flex-1 flex-col"
              dangerouslySetInnerHTML={{ __html: peekSnapshot }}
            />
          ) : (
            <VaultTitleRow
              name={peekVault.name}
              dotColor={resolveVaultAccent(peekVault.accentColor)}
              className="pt-2"
            />
          ))}
      </div>
    </div>
  )
}

/** Next/previous vault from the keyboard; bindings live in the shortcut registry. */
function useAdjacentVaultShortcuts(): void {
  const next = useShortcutBinding('nav.nextVault')
  const prev = useShortcutBinding('nav.prevVault')

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const isNext = matchesShortcut(event, next.key, next.modifiers)
      const isPrev = !isNext && matchesShortcut(event, prev.key, prev.modifiers)
      if (!isNext && !isPrev) return
      if (isPlainTextInputFocused()) return
      event.preventDefault()
      event.stopPropagation()
      // The arrows are spatial: in RTL the next vault sits to the left.
      const rtl = document.documentElement.dir === 'rtl'
      requestVaultPage({ step: isNext !== rtl ? 1 : -1 })
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [next, prev])
}
