// Email sign-in, first-device setup and the recovery phrase confirmation against the real Worker
// (Miniflare), ported from apps/desktop/tests/e2e/auth-state-machine.e2e.ts. The two Electron tests
// that sign out and sign back in (same-device re-auth, wrong phrase on the link step) wait for
// Step 19 A4: sign-out (`window.api.syncAuth.logout`) is not ported.
import { createHmac, randomUUID } from 'node:crypto'

import { test as base, expect } from '../../harness/test'
import type { Page } from '../../harness/pw-compat/page'
import { type SharedSyncBootstrap, startSharedSyncBootstrap } from '../../harness/sync-backend'

const OTP_CODE = '123456'
const OTP_HMAC_KEY = 'test-otp-hmac-key'

const test = base.extend<{ syncBootstrap: SharedSyncBootstrap; syncServerUrl: string | null }>({
  // oxlint-disable-next-line no-empty-pattern -- the harness reads a fixture's deps from the first-argument destructuring
  syncBootstrap: async ({}, provide) => {
    // workerd (Miniflare's runtime) ships no win32-arm64 build: it throws "Unsupported platform:
    // win32 arm64 LE". Every other e2e leg runs this spec.
    base.skip(
      process.platform === 'win32' && process.arch === 'arm64',
      'workerd has no win32-arm64 build'
    )
    const bootstrap = await startSharedSyncBootstrap()
    try {
      await provide(bootstrap)
    } finally {
      await bootstrap.server.stop()
    }
  },
  syncServerUrl: async ({ syncBootstrap }, provide) => {
    await provide(syncBootstrap.serverUrl)
  }
})

// The statements of the Worker's `storeOtp` (apps/sync-server/src/services/otp.ts:51-77). Not an
// import: the sync-server package is CommonJS to the spec loader, which drops its named exports.
async function seedOtp(syncBootstrap: SharedSyncBootstrap, email: string): Promise<void> {
  const db = await syncBootstrap.server.getD1()
  const now = Math.floor(Date.now() / 1000)
  const codeHash = createHmac('sha256', OTP_HMAC_KEY).update(OTP_CODE).digest('hex')
  await db.prepare('UPDATE otp_codes SET used = 1 WHERE email = ? AND used = 0').bind(email).run()
  await db
    .prepare(
      'INSERT INTO otp_codes (id, email, code_hash, expires_at, attempts, used, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)'
    )
    .bind(randomUUID(), email, codeHash, now + 600, now)
    .run()
}

async function seedExpiredOtp(syncBootstrap: SharedSyncBootstrap, email: string): Promise<void> {
  await seedOtp(syncBootstrap, email)
  const db = await syncBootstrap.server.getD1()
  await db
    .prepare('UPDATE otp_codes SET expires_at = ? WHERE email = ? AND used = 0')
    .bind(Math.floor(Date.now() / 1000) - 1, email)
    .run()
}

async function openAccountSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Account', exact: true }).click()
  await expect(page.getByText('Set up Sync')).toBeVisible()
}

async function requestOtpFromUi(page: Page, email: string): Promise<void> {
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByText('Enter verification code')).toBeVisible()
}

async function submitOtp(page: Page, code = OTP_CODE): Promise<void> {
  await page.getByLabel('6-digit verification code').fill(code)
}

async function readRecoveryWords(page: Page): Promise<string[]> {
  await expect(page.getByText('Save your recovery phrase')).toBeVisible()
  const words = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-label="Recovery phrase words"] li')].map((item) =>
      (item.getAttribute('aria-label') ?? '').replace(/^Word \d+:\s*/, '')
    )
  )
  // Counts only: a failed assert on the words would print the phrase into the CI log.
  expect(words.length).toBe(24)
  expect(words.every((word) => word.length > 0)).toBe(true)
  return words
}

async function openConfirmation(page: Page): Promise<void> {
  await page.getByRole('button', { name: "I've saved my recovery phrase" }).click()
  await expect(page.getByText('Confirm your recovery phrase')).toBeVisible()
  await expect(page.locator('input[aria-label^="Enter word #"]')).toHaveCount(3)
}

async function confirmRecoveryWords(page: Page, words: string[]): Promise<void> {
  await openConfirmation(page)
  const inputs = page.locator('input[aria-label^="Enter word #"]')
  for (let i = 0; i < 3; i++) {
    const input = inputs.nth(i)
    const label = await input.getAttribute('aria-label')
    const wordIndex = Number(label?.match(/#(\d+)/)?.[1] ?? 0)
    expect(wordIndex).toBeGreaterThan(0)
    await input.fill(words[wordIndex - 1])
  }
  await page.getByRole('button', { name: 'Verify' }).click()
}

/** `account_get_info` stands in for Electron's `account.getInfo` + `syncDevices.getDevices`. */
async function expectAuthenticated(page: Page, email: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const info = (await window.__TAURI__.core.invoke('account_get_info')) as {
          signedIn: boolean
          email: string | null
          deviceId: string | null
          needsRecoveryConfirmation: boolean
        }
        return { ...info, hasDevice: typeof info.deviceId === 'string' }
      })
    )
    .toMatchObject({ signedIn: true, email, hasDevice: true, needsRecoveryConfirmation: false })
}

test.describe('Auth state machine E2E', () => {
  test('sets up sync and confirms the recovery phrase', async ({ page, syncBootstrap }) => {
    const email = syncBootstrap.email

    await openAccountSettings(page)
    await requestOtpFromUi(page, email)
    await seedOtp(syncBootstrap, email)
    await submitOtp(page)

    const recoveryWords = await readRecoveryWords(page)
    await confirmRecoveryWords(page, recoveryWords)
    await expectAuthenticated(page, email)
  })

  // A rejected code keeps the attempt waiting for its code, so the right code still sets up.
  test('keeps setup on OTP step when the code is wrong', async ({ page, syncBootstrap }) => {
    const email = syncBootstrap.email

    await openAccountSettings(page)
    await requestOtpFromUi(page, email)
    await seedOtp(syncBootstrap, email)
    await submitOtp(page, '000000')

    await expect(page.getByText('Invalid OTP code')).toBeVisible()
    await expect(page.getByText('Enter verification code')).toBeVisible()
    await expect(page.getByText('Save your recovery phrase')).toHaveCount(0)

    await submitOtp(page)
    await readRecoveryWords(page)
  })

  test('keeps setup on OTP step when the code is expired', async ({ page, syncBootstrap }) => {
    const email = syncBootstrap.email

    await openAccountSettings(page)
    await requestOtpFromUi(page, email)
    await seedExpiredOtp(syncBootstrap, email)
    await submitOtp(page)

    await expect(page.getByText('OTP expired or not found')).toBeVisible()
    await expect(page.getByText('Enter verification code')).toBeVisible()
    await expect(page.getByText('Save your recovery phrase')).toHaveCount(0)

    await seedOtp(syncBootstrap, email)
    await submitOtp(page)
    await readRecoveryWords(page)
  })

  test('blocks setup completion when the recovery confirmation words are wrong', async ({
    page,
    syncBootstrap
  }) => {
    const email = syncBootstrap.email

    await openAccountSettings(page)
    await requestOtpFromUi(page, email)
    await seedOtp(syncBootstrap, email)
    await submitOtp(page)
    await readRecoveryWords(page)

    await openConfirmation(page)
    const inputs = page.locator('input[aria-label^="Enter word #"]')
    for (let i = 0; i < 3; i++) await inputs.nth(i).fill(`wrong-${i}`)

    await expect(page.getByRole('button', { name: 'Verify' })).toBeDisabled()
    await expect(page.getByText('Confirm your recovery phrase')).toBeVisible()
    await expect(page.getByText("You're all set")).toHaveCount(0)
  })
})
