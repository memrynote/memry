export interface VisibleViewportMetrics {
  layoutHeight: number
  viewportHeight: number
  viewportOffsetTop: number
}

export interface VisibleViewportState {
  bottomInset: number
  keyboardVisible: boolean
}

export interface VisibleViewportController {
  getState(): VisibleViewportState
  destroy(): void
}

/**
 * How much of the frame the software keyboard covers, or `null` when this
 * frame cannot say.
 *
 * `visualViewport.height` only means "the part a person can see" while the
 * visual viewport is at REST. Scroll down with the keyboard up and WKWebView
 * pans the visual viewport towards the layout viewport's bottom, after which
 * `height` reports the distance left to that bottom and
 * `height + offsetTop === layoutHeight` identically. A frame taken mid-pan says
 * nothing about the keyboard, so it is refused rather than believed: the
 * keyboard did not move while the reader's finger did.
 */
export function visibleViewportOccludedHeight(metrics: VisibleViewportMetrics): number | null {
  if (Math.round(metrics.viewportOffsetTop) > 0) return null
  return Math.max(0, Math.round(metrics.layoutHeight - metrics.viewportHeight))
}

/**
 * Where chrome pinned to the bottom of the WebView's fixed layer has to sit.
 *
 * NEGATIVE on purpose. WKWebView carries that layer up with the pan, so past
 * the occluded height the chrome has to be pushed back DOWN below the layer's
 * own bottom edge to stay on the keyboard. Clamping this at zero is what let
 * the formatting toolbar climb the screen on every downward scroll and snap
 * back on the way up (#2131).
 */
export function visibleViewportBottomInset(
  occludedHeight: number,
  viewportOffsetTop: number
): number {
  return Math.round(occludedHeight - viewportOffsetTop)
}

export function visibleViewportState(
  metrics: VisibleViewportMetrics,
  latchedOccludedHeight: number
): VisibleViewportState {
  const occludedHeight = visibleViewportOccludedHeight(metrics) ?? latchedOccludedHeight
  return {
    bottomInset: visibleViewportBottomInset(occludedHeight, metrics.viewportOffsetTop),
    keyboardVisible: occludedHeight > 0
  }
}

/**
 * Keep WebView chrome on the visible viewport, not underneath the iOS keyboard.
 *
 * WKWebView leaves its layout viewport at the pre-keyboard height while
 * `visualViewport` reports the part a person can still see. React Native's
 * KeyboardAvoidingView cannot correct fixed DOM chrome because it only adds
 * native wrapper padding; this CSS inset closes that boundary explicitly.
 *
 * The occluded height is carried across frames because only the resting ones
 * can measure it; see `visibleViewportOccludedHeight`.
 */
export function installVisibleViewportInset(
  onKeyboardVisibilityChange?: (visible: boolean) => void
): VisibleViewportController {
  const viewport = window.visualViewport
  const root = document.documentElement
  let state: VisibleViewportState = { bottomInset: 0, keyboardVisible: false }
  let occludedHeight = 0

  const update = (): void => {
    const layoutHeight = Math.max(window.innerHeight, root.clientHeight)
    const metrics = viewport
      ? {
          layoutHeight,
          viewportHeight: viewport.height,
          viewportOffsetTop: viewport.offsetTop
        }
      : { layoutHeight, viewportHeight: layoutHeight, viewportOffsetTop: 0 }
    occludedHeight = visibleViewportOccludedHeight(metrics) ?? occludedHeight
    const next = visibleViewportState(metrics, occludedHeight)
    root.style.setProperty('--memry-viewport-bottom-inset', `${next.bottomInset}px`)
    const visibilityChanged = next.keyboardVisible !== state.keyboardVisible
    state = next
    // `visualViewport.resize` fires for every keyboard animation frame. Native
    // chrome needs the state transition, not a stream of intermediate insets.
    if (visibilityChanged) onKeyboardVisibilityChange?.(next.keyboardVisible)
  }

  update()
  window.addEventListener('resize', update)
  viewport?.addEventListener('resize', update)
  viewport?.addEventListener('scroll', update)

  return {
    getState: () => state,
    destroy: () => {
      window.removeEventListener('resize', update)
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
    }
  }
}
