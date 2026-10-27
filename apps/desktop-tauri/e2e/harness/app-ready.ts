import { expect } from './pw-compat'
import type { Page } from './pw-compat/page'
import { vaultStatus } from './vault-commands'

/** The vault is open and the app shell (title row and sidebar trigger) is mounted. */
export async function appReady(page: Page): Promise<void> {
  await expect.poll(async () => (await vaultStatus(page)).isOpen, { timeout: 45_000 }).toBe(true)
  await page.locator('[data-sidebar="trigger"]').first().waitFor({ state: 'visible' })
}
