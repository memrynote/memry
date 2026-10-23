import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import App from './App.tsx'
import { preloadRoute } from '@/routes'

/**
 * Everything the first paint does not need: React, the router, the animation runtime
 * and the page itself. main.tsx imports this only once a frame has been composited,
 * so the ~500ms of module evaluation lands after the prerendered document is on
 * screen instead of in front of it.
 *
 * The chunk is downloaded in parallel with that first frame — see the modulepreload
 * scripts/prerender.ts writes into <head> — so waiting costs the download nothing.
 */
export async function mount(): Promise<void> {
  const root = document.getElementById('root')!
  const prerendered = root.hasChildNodes()

  const app = (
    <StrictMode>
      <App />
    </StrictMode>
  )

  if (!prerendered) {
    // No server markup to adopt: a route outside the prerender list, or the dev server.
    createRoot(root).render(app)
    return
  }

  // react-helmet-async re-inserts the tags it manages on mount, so the prerendered
  // copies have to go first or the document ends up with two titles and two canonicals.
  document.head.querySelectorAll('[data-rh="true"]').forEach((node) => node.remove())

  // A route chunk that has not arrived yet makes React treat the boundary as suspended
  // and throw away the server HTML it was about to adopt — the page would blank out and
  // come back. Resolve it before hydrating.
  await preloadRoute(window.location.pathname)
  hydrateRoot(root, app)
}
