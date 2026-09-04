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
 * `allowInvalidContainer` is deliberately not used — it silences the message
 * and leaves the renderer sized 1×0.
 */
export function refreshSigmaIfMeasurable(sigma: Sigma, opts?: SigmaRefreshOptions): boolean {
  if (sigma.getContainer().offsetWidth === 0) return false
  sigma.refresh(opts)
  return true
}
