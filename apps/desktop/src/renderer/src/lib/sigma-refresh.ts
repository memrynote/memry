import { useEffect } from 'react'
import type { Sigma } from 'sigma'

type SigmaRefreshOptions = Parameters<Sigma['refresh']>[0]

/**
 * Every `sigma.refresh()` renders, and `render()` starts by re-measuring the
 * container — which throws outright when the container is 0px wide:
 * "Sigma: Container has no width."
 *
 * The graph refreshes from animation frames (physics stepping, hover fades).
 * React cancels those frames in a passive-effect cleanup, which runs *after*
 * the mutation phase has already detached the container, so a frame queued
 * before a teardown still lands on a detached — and therefore 0-width — node
 * and the throw escapes to `window.onerror`. Skipping the paint is the whole
 * fix: a container with no width has nothing to show, and one that regains a
 * width gets repainted by the next frame.
 *
 * This guard only covers the refreshes the graph components make themselves.
 * Sigma also schedules its own render frames (setSetting, graph attribute
 * updates from the physics loop, camera moves, window resize), and those hit
 * the same teardown race; `SIGMA_ALLOW_INVALID_CONTAINER` covers them.
 */
export function refreshSigmaIfMeasurable(sigma: Sigma, opts?: SigmaRefreshOptions): boolean {
  if (sigma.getContainer().offsetWidth === 0) return false
  sigma.refresh(opts)
  return true
}

/**
 * Sigma setting for every graph renderer. sigma@3.0.3's `resize()` throws
 * "Sigma: Container has no width" on a 0px container unless this is set, in
 * which case it sizes the canvases 1px and carries on. Sigma's internally
 * scheduled render frames (see `refreshSigmaIfMeasurable`) cannot be guarded
 * from outside, so this is what stops the teardown race from reaching
 * `window.onerror` (#2531). The 1px size is not sticky: every render
 * re-measures, and `useRepaintSigmaWhenContainerRegainsWidth` forces that
 * render when a container comes back from 0px.
 */
export const SIGMA_ALLOW_INVALID_CONTAINER = { allowInvalidContainer: true } as const

/**
 * Repaint Sigma when its container goes from 0px wide back to a real width.
 *
 * With `allowInvalidContainer`, a render into a 0px container leaves the
 * canvases 1px wide. Sigma re-measures only on its own renders and on window
 * resize, so a container that regains its width any other way would stay
 * blank until something else happened to repaint it.
 */
export function useRepaintSigmaWhenContainerRegainsWidth(sigma: Sigma): void {
  useEffect(() => {
    const container = sigma.getContainer()
    let hadWidth = container.offsetWidth > 0
    const observer = new ResizeObserver(() => {
      const hasWidth = container.offsetWidth > 0
      if (hasWidth && !hadWidth) refreshSigmaIfMeasurable(sigma)
      hadWidth = hasWidth
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [sigma])
}
