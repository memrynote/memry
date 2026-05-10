import type { Page } from '@playwright/test'
import { storeOtp } from '../../../sync-server/src/services/otp'
import { test, expect } from './fixtures/sync-auth-fixtures'
import type { SharedSyncBootstrap } from './utils/sync-backend'

const OTP_CODE = '123456'
const OTP_HMAC_KEY = 'test-otp-hmac-key'
const WRONG_VALID_RECOVERY_PHRASE = [
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'art'
].join(' ')

async function seedOtp(syncBootstrap: SharedSyncBootstrap, email: string): Promise<void> {
  await storeOtp(await syncBootstrap.server.getD1(), email, OTP_CODE, OTP_HMAC_KEY)
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
  await page.evaluate(() => window.api.quickCapture.openSettings('account'))
  await expect(page.getByRole('dialog')).toBeVisible()
}

async function requestOtpFromUi(
  page: Page,
  syncBootstrap: SharedSyncBootstrap,
  email: string
): Promise<void> {
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByText('Enter verification code')).toBeVisible()
  await seedOtp(syncBootstrap, email)
}

async function submitOtp(page: Page): Promise<void> {
  await page.getByLabel('6-digit verification code').fill(OTP_CODE)
}

async function readRecoveryWords(page: Page): Promise<string[]> {
  await expect(page.getByText('Save your recovery phrase')).toBeVisible()
  const words = await page
    .locator('[aria-label="Recovery phrase words"] [role="listitem"]')
    .evaluateAll((items) =>
      items.map((item) => (item.getAttribute('aria-label') ?? '').replace(/^Word \d+:\s*/, ''))
    )

  expect(words).toHaveLength(24)
  expect(words.every((word) => word.length > 0)).toBe(true)
  return words
}

async function confirmRecoveryWords(page: Page, words: string[]): Promise<void> {
  await page.getByRole('button', { name: "I've saved my recovery phrase" }).click()
  await expect(page.getByText('Confirm your recovery phrase')).toBeVisible()

  const inputs = page.locator('input[placeholder^="Enter word #"]')
  const count = await inputs.count()
  expect(count).toBe(3)

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i)
    const placeholder = await input.getAttribute('placeholder')
    const wordIndex = Number(placeholder?.match(/#(\d+)/)?.[1] ?? 0)
    expect(wordIndex).toBeGreaterThan(0)
    await input.fill(words[wordIndex - 1])
  }

  await page.getByRole('button', { name: 'Verify' }).click()
}

async function fillWrongConfirmationWords(page: Page): Promise<void> {
  await page.getByRole('button', { name: "I've saved my recovery phrase" }).click()
  await expect(page.getByText('Confirm your recovery phrase')).toBeVisible()

  const inputs = page.locator('input[placeholder^="Enter word #"]')
  const count = await inputs.count()
  expect(count).toBe(3)

  for (let i = 0; i < count; i++) {
    await inputs.nth(i).fill(`wrong-${i}`)
  }
}

async function expectAuthenticated(page: Page, email: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const [account, devices] = await Promise.all([
          window.api.account.getInfo(),
          window.api.syncDevices.getDevices()
        ])
        return {
          email: account.email,
          hasJoinedAt: typeof account.joinedAt === 'number',
          deviceEmail: devices.email,
          currentDeviceCount: devices.devices.filter((device) => device.isCurrentDevice).length
        }
      })
    )
    .toMatchObject({
      email,
      hasJoinedAt: true,
      deviceEmail: email,
      currentDeviceCount: 1
    })
}

test.describe('Auth state machine E2E', () => {
  test('sets up sync, confirms recovery, signs out, and re-authenticates same device', async ({
    pageA,
    syncBootstrap
  }) => {
    const email = syncBootstrap.email

    await openAccountSettings(pageA)
    await requestOtpFromUi(pageA, syncBootstrap, email)
    await submitOtp(pageA)

    const recoveryWords = await readRecoveryWords(pageA)
    await confirmRecoveryWords(pageA, recoveryWords)
    await expectAuthenticated(pageA, email)

    await pageA.getByRole('button', { name: 'Sign Out' }).click()
    await pageA.getByRole('button', { name: 'Sign out' }).click()
    await expect(pageA.getByText('Set up Sync')).toBeVisible()
    const signedOutAccount = await pageA.evaluate(() => window.api.account.getInfo())
    expect(signedOutAccount).toEqual({
      email: null,
      joinedAt: null
    })

    await requestOtpFromUi(pageA, syncBootstrap, email)
    await submitOtp(pageA)
    await expect(pageA.getByText('Link this device')).toBeVisible()
    await pageA.getByRole('button', { name: 'Recovery phrase' }).click()
    await pageA.getByLabel('Recovery phrase').fill(recoveryWords.join(' '))
    await pageA.getByRole('button', { name: 'Restore access' }).click()

    await expectAuthenticated(pageA, email)
  })

  test('keeps setup on OTP step when the code is wrong', async ({ pageA, syncBootstrap }) => {
    const email = syncBootstrap.email

    await openAccountSettings(pageA)
    await pageA.getByLabel('Email address').fill(email)
    await pageA.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(pageA.getByText('Enter verification code')).toBeVisible()
    await seedOtp(syncBootstrap, email)

    await pageA.getByLabel('6-digit verification code').fill('000000')

    await expect(pageA.getByText('Invalid OTP code')).toBeVisible()
    await expect(pageA.getByText('Enter verification code')).toBeVisible()
    await expect(pageA.getByText('Save your recovery phrase')).toHaveCount(0)
  })

  test('keeps setup on OTP step when the code is expired', async ({ pageA, syncBootstrap }) => {
    const email = syncBootstrap.email

    await openAccountSettings(pageA)
    await pageA.getByLabel('Email address').fill(email)
    await pageA.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(pageA.getByText('Enter verification code')).toBeVisible()
    await seedExpiredOtp(syncBootstrap, email)

    await submitOtp(pageA)

    await expect(pageA.getByText('OTP expired or not found')).toBeVisible()
    await expect(pageA.getByText('Enter verification code')).toBeVisible()
    await expect(pageA.getByText('Save your recovery phrase')).toHaveCount(0)
  })

  test('blocks setup completion when the recovery confirmation words are wrong', async ({
    pageA,
    syncBootstrap
  }) => {
    const email = syncBootstrap.email

    await openAccountSettings(pageA)
    await requestOtpFromUi(pageA, syncBootstrap, email)
    await submitOtp(pageA)
    await readRecoveryWords(pageA)

    await fillWrongConfirmationWords(pageA)

    await expect(pageA.getByRole('button', { name: 'Verify' })).toBeDisabled()
    await expect(pageA.getByText('Confirm your recovery phrase')).toBeVisible()
    await expect(pageA.getByText("You're all set")).toHaveCount(0)
  })

  test('keeps linking on recovery step when the recovery phrase is wrong', async ({
    pageA,
    syncBootstrap
  }) => {
    const email = syncBootstrap.email

    await openAccountSettings(pageA)
    await requestOtpFromUi(pageA, syncBootstrap, email)
    await submitOtp(pageA)

    const recoveryWords = await readRecoveryWords(pageA)
    await confirmRecoveryWords(pageA, recoveryWords)
    await expectAuthenticated(pageA, email)

    await pageA.getByRole('button', { name: 'Sign Out' }).click()
    await pageA.getByRole('button', { name: 'Sign out' }).click()
    await expect(pageA.getByText('Set up Sync')).toBeVisible()

    await requestOtpFromUi(pageA, syncBootstrap, email)
    await submitOtp(pageA)
    await expect(pageA.getByText('Link this device')).toBeVisible()
    await pageA.getByRole('button', { name: 'Recovery phrase' }).click()

    await pageA.getByLabel('Recovery phrase').fill(WRONG_VALID_RECOVERY_PHRASE)
    await pageA.getByRole('button', { name: 'Restore access' }).click()

    await expect(pageA.getByText('Recovery phrase does not match. Please try again.')).toBeVisible()
    await expect(pageA.getByLabel('Recovery phrase')).toBeVisible()
    await expect
      .poll(() => pageA.evaluate(() => window.api.account.getInfo()))
      .toMatchObject({ email, joinedAt: null })
  })
})
