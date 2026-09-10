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

/** Distance between the visible viewport and the layout viewport's bottom. */
export function visibleViewportBottomInset(metrics: VisibleViewportMetrics): number {
  const { layoutHeight, viewportHeight, viewportOffsetTop } = metrics
  return Math.max(0, Math.round(layoutHeight - viewportHeight - viewportOffsetTop))
}

/**
 * Whether something — in practice the software keyboard — is covering part of
 * the frame.
 *
 * Deliberately NOT `bottomInset > 0`. The inset is a POSITION and it decays to
 * zero on its own: scrolling with the keyboard up walks `offsetTop` all the way
 * up to the occluded height, at which point the visible viewport ends exactly
 * at the layout viewport's bottom and chrome pinned to that bottom is already
 * in the right place. Reading that as "the keyboard went away" is what used to
 * delete the toolbar part-way down a note (#2131). The occlusion itself is the
 * height the visible viewport is SHORT by, and that number does not move while
 * the reader scrolls.
 */
export function visibleViewportOccludedHeight(metrics: VisibleViewportMetrics): number {
  return Math.max(0, Math.round(metrics.layoutHeight - metrics.viewportHeight))
}

export function visibleViewportState(metrics: VisibleViewportMetrics): VisibleViewportState {
  return {
    bottomInset: visibleViewportBottomInset(metrics),
    keyboardVisible: visibleViewportOccludedHeight(metrics) > 0
  }
}

/**
 * Keep WebView chrome on the visible viewport, not underneath the iOS keyboard.
 *
 * WKWebView leaves its layout viewport at the pre-keyboard height while
 * `visualViewport` reports the part a person can still see. React Native's
 * KeyboardAvoidingView cannot correct fixed DOM chrome because it only adds
 * native wrapper padding; this CSS inset closes that boundary explicitly.
 */
export function installVisibleViewportInset(
  onKeyboardVisibilityChange?: (visible: boolean) => void
): VisibleViewportController {
  const viewport = window.visualViewport
  const root = document.documentElement
  let state: VisibleViewportState = { bottomInset: 0, keyboardVisible: false }

  const update = (): void => {
    const layoutHeight = Math.max(window.innerHeight, root.clientHeight)
    const next = viewport
      ? visibleViewportState({
          layoutHeight,
          viewportHeight: viewport.height,
          viewportOffsetTop: viewport.offsetTop
        })
      : { bottomInset: 0, keyboardVisible: false }
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
