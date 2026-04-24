import { type Page, expect } from '@playwright/test'

/**
 * Dismiss the mock first-run onboarding if it appears. The M1 settings mock
 * returns `onboardingCompleted: false` so every fresh page load shows the
 * Welcome splash until the user clicks through. FirstRunOnboarding is a
 * multi-step wizard (Welcome → Create first note → Set up sync → Install
 * extension) with a close-X button in the top-right we can use to skip the
 * entire flow in one click.
 *
 * We look for either the close-X (aria-label "Close"), the wizard's "Skip"
 * button, or the top-level overlay backdrop — whichever is fastest to
 * dismiss.
 */
export async function dismissOnboarding(page: Page): Promise<void> {
  // The wizard overlay is a fixed inset-0 backdrop with z-50.
  const overlay = page.locator('div.fixed.inset-0.z-50').first()
  if (!(await overlay.isVisible({ timeout: 1500 }).catch(() => false))) {
    return
  }

  // Preferred exit: "Skip onboarding" close-X in the wizard's card header.
  // Dismisses the whole wizard in one click regardless of which step is active.
  const closeX = page.getByRole('button', { name: /skip onboarding/i }).first()
  if (await closeX.isVisible({ timeout: 1000 }).catch(() => false)) {
    await closeX.click()
    await overlay.waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined)
  }
}

/**
 * Click a primary sidebar nav item by its visible label.
 */
export async function navigateTo(
  page: Page,
  label: 'Inbox' | 'Journal' | 'Calendar' | 'Tasks'
): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${label}`, 'i') }).first().click()
}

/**
 * Go to "/" and dismiss onboarding. Most per-route specs start here.
 */
export async function bootApp(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await dismissOnboarding(page)
  // Wait for sidebar primary nav to mount — signals shell is ready.
  await expect(page.getByRole('button', { name: /inbox/i }).first()).toBeVisible({
    timeout: 10_000
  })
}

/**
 * Allow-list for console errors that the M1 mock-only renderer emits but
 * don't indicate actual regressions. M2+ backends will eliminate most of
 * these (session restore query fixed, logger init removed from renderer).
 */
export function isAllowedConsoleNoise(msg: string): boolean {
  return (
    msg.includes('Notification prompting') ||
    msg.includes("electron-log: logger isn't initialized") ||
    msg.includes('Query data cannot be undefined') ||
    msg.includes('setState() call inside')
  )
}
