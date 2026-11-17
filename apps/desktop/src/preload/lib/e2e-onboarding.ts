/**
 * Mark the first-run onboarding and the iPhone beta launch prompt as seen before
 * the renderer mounts, for E2E runs only. Every E2E launch has a fresh profile, so
 * both would otherwise open in every spec and their overlays intercept every click.
 *
 * `useFirstRunTour` reads its localStorage flag once, inside a mount effect, and
 * the iPhone beta store caches its snapshot on first read. A test that writes the
 * flags after the window is up therefore races the renderer: lose the race and
 * the overlay is already on screen, where it swallows pointer events for the rest
 * of the test and every later click times out. The only place reliably earlier
 * than the renderer is here — preload runs before the page's own scripts.
 *
 * Gated on `TEST_VAULT_PATH`, the variable the main process already treats as
 * the E2E signal when it auto-opens the fixture's vault, so a packaged build
 * never takes this path. Deliberately NOT gated on `NODE_ENV`: electron-vite
 * inlines `process.env.NODE_ENV` as 'production' in the preload bundle, which
 * turns the body into dead code the bundler then drops entirely.
 */

const TOUR_KEY = 'memry:onboarding:tour:v1'
const STAR_KEY = 'memry:onboarding:star:v1'
// Owned by the renderer's `ios-beta-store.ts`.
const IOS_BETA_KEY = 'memry:ios-beta'

export function suppressFirstRunPromptsInE2E(): void {
  if (!process.env['TEST_VAULT_PATH']) return

  try {
    window.localStorage.setItem(TOUR_KEY, '1')
    window.localStorage.setItem(STAR_KEY, 'done')
    // Only when absent, so a spec that seeded its own iPhone beta state keeps it.
    if (window.localStorage.getItem(IOS_BETA_KEY) === null) {
      window.localStorage.setItem(
        IOS_BETA_KEY,
        JSON.stringify({ joinedEmail: null, promptSeen: true })
      )
    }
  } catch {
    // localStorage may be unavailable; the test-side dismissal still applies.
  }
}
