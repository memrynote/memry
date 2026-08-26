import 'lenis/dist/lenis.css'
import './index.css'

/**
 * The entry chunk is deliberately almost empty: a stylesheet import and a wait.
 *
 * Every route is prerendered to static HTML (scripts/prerender.ts), so the page is
 * ready to paint the moment it arrives. A module script runs as soon as parsing
 * finishes, though — before that first paint — which put React's module evaluation and
 * hydration in front of the hero on a phone, for a document that needed neither to be
 * shown. Two frames is the reliable way to wait for a paint: the first callback runs
 * before the coming frame is composited, the second after it.
 *
 * Links and forms in the server HTML work throughout the wait; only controls that need
 * JS (the mobile menu, the demo dialog) come alive a frame later.
 */
function afterFirstPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

void afterFirstPaint()
  .then(() => import('./boot.tsx'))
  .then((boot) => boot.mount())
