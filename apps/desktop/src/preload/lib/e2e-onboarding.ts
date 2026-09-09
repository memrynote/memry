/**
 * Mark the first-run onboarding as seen before the renderer mounts, for E2E
 * runs only.
 *
 * `useFirstRunTour` reads its localStorage flag once, inside a mount effect. A
 * test that writes the flag after the window is up therefore races that effect:
 * lose the race and driver.js has already appended its overlay <svg> to
 * <body>, where it swallows pointer events for the rest of the test and every
 * later click times out. The only place reliably earlier than the renderer is
 * here — preload runs before the page's own scripts.
 *
 * Gated on `TEST_VAULT_PATH`, the variable the main process already treats as
 * the E2E signal when it auto-opens the fixture's vault, so a packaged build
 * never takes this path. Deliberately NOT gated on `NODE_ENV`: electron-vite
 * inlines `process.env.NODE_ENV` as 'production' in the preload bundle, which
 * turns the body into dead code the bundler then drops entirely.
 */

const TOUR_KEY = 'memry:onboarding:tour:v1'
const STAR_KEY = 'memry:onboarding:star:v1'

export function suppressFirstRunOnboardingInE2E(): void {
  if (!process.env['TEST_VAULT_PATH']) return

  try {
    window.localStorage.setItem(TOUR_KEY, '1')
    window.localStorage.setItem(STAR_KEY, 'done')
  } catch {
    // localStorage may be unavailable; the test-side dismissal still applies.
  }
}
