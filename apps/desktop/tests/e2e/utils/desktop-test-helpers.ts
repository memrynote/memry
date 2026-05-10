import type { Page } from '@playwright/test'
import { dismissFirstRunOnboarding, waitForAppReady, waitForVaultReady } from './electron-helpers'

export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

export const PNG_BYTES = [
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0,
  0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 96, 0, 0, 0, 6, 0, 2, 48, 129,
  208, 47, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
]

export async function ready(page: Page): Promise<void> {
  await waitForAppReady(page)
  await waitForVaultReady(page)
  await dismissFirstRunOnboarding(page)
}

export function uniqueLabel(label: string): string {
  return `E2E ${label} ${Date.now()}`
}
