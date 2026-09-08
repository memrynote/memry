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
export function visibleViewportBottomInset(_metrics: VisibleViewportMetrics): number {
  const { layoutHeight, viewportHeight, viewportOffsetTop } = _metrics
  return Math.max(0, Math.round(layoutHeight - viewportHeight - viewportOffsetTop))
}

export function visibleViewportState(metrics: VisibleViewportMetrics): VisibleViewportState {
  const bottomInset = visibleViewportBottomInset(metrics)
  return { bottomInset, keyboardVisible: bottomInset > 0 }
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
