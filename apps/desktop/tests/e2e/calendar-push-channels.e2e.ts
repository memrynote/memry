/**
 * Calendar push channels — Google webhook round-trip (M4b, Task 12).
 *
 * This suite is flag-gated and will be SKIPPED until all of the following are set:
 *   - GOOGLE_CALENDAR_E2E=1                  (global opt-in)
 *   - CALENDAR_PUSH_ENABLED=1                (toggles the desktop feature flag)
 *   - MEMRY_WEBHOOK_HMAC_KEY=<key>           (must match sync-server binding)
 *   - GOOGLE_CALENDAR_E2E_REFRESH_TOKEN=<…>  (refresh token for the CI test account)
 *   - GOOGLE_CALENDAR_E2E_CLIENT_ID=<…>      (OAuth client the refresh token belongs to)
 *   - GOOGLE_CALENDAR_E2E_CLIENT_SECRET=<…>  (optional: only if the client is confidential)
 *   - GOOGLE_CALENDAR_E2E_CALENDAR_ID=<…>    (test calendar the spec creates/deletes events on)
 *
 * Ops prerequisites (one-time, not yet done as of 2026-04-19):
 *   1. sync.memry.io HTTPS webhook endpoint reachable from Google.
 *   2. The domain verified in Google Cloud Console → APIs → Domain verification.
 *   3. sync-server deployed with matching MEMRY_WEBHOOK_HMAC_KEY binding.
 *
 * Once the above is green, the tests below exercise the full round-trip:
 *   - connect → channel registered → resourceId stored server-side
 *   - event mutation on Google side → webhook fires → DO broadcasts
 *     calendar_changes_available → desktop runs syncGoogleCalendarSource →
 *     Memry UI reflects the change within a few seconds.
 *   - disconnect → channel drained both on Google and sync-server.
 */
import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

const CREDS_PRESENT =
  process.env.GOOGLE_CALENDAR_E2E === '1' &&
  process.env.CALENDAR_PUSH_ENABLED === '1' &&
  !!process.env.MEMRY_WEBHOOK_HMAC_KEY &&
  !!process.env.GOOGLE_CALENDAR_E2E_REFRESH_TOKEN &&
  !!process.env.GOOGLE_CALENDAR_E2E_CLIENT_ID &&
  !!process.env.GOOGLE_CALENDAR_E2E_CALENDAR_ID

interface ChannelProbe {
  activeCount: number
}

test.describe('Google calendar push channels (M4b round-trip)', () => {
  test.skip(
    !CREDS_PRESENT,
    'Flag-gated: set GOOGLE_CALENDAR_E2E=1, CALENDAR_PUSH_ENABLED=1, MEMRY_WEBHOOK_HMAC_KEY, plus the ' +
      'GOOGLE_CALENDAR_E2E_{REFRESH_TOKEN,CLIENT_ID,CALENDAR_ID} secrets. Requires sync.memry.io ' +
      'domain-verified in Google Cloud Console.'
  )

  test.beforeEach(async ({ page, electronApp }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)

    // Seed keytar with the test account's refresh token so the Google client can refresh
    // access tokens without driving the OAuth popup. Exposed via the test hook that other
    // calendar suites already use (see __memryTestHooks in index.ts).
    await electronApp.evaluate(
      async (_ctx, input) => {
        const hooks = (
          globalThis as typeof globalThis & {
            __memryTestHooks?: {
              seedGoogleCalendarTokens(input: {
                refreshToken: string
                clientId: string
                clientSecret: string | null
              }): Promise<void>
            }
          }
        ).__memryTestHooks
        if (!hooks?.seedGoogleCalendarTokens) {
          throw new Error(
            'Missing __memryTestHooks.seedGoogleCalendarTokens — add it in the test-hook ' +
              'surface before enabling this E2E suite.'
          )
        }
        await hooks.seedGoogleCalendarTokens(input)
      },
      {
        refreshToken: process.env.GOOGLE_CALENDAR_E2E_REFRESH_TOKEN!,
        clientId: process.env.GOOGLE_CALENDAR_E2E_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CALENDAR_E2E_CLIENT_SECRET ?? null
      }
    )
  })

  test('registers a Google push channel after connecting; drains it on disconnect', async ({
    page,
    electronApp
  }) => {
    // #given Google Calendar is not yet connected
    const probeBefore = await electronApp.evaluate(async () => {
      const hooks = (
        globalThis as typeof globalThis & {
          __memryTestHooks?: { getGooglePushChannelProbe(): Promise<ChannelProbe> }
        }
      ).__memryTestHooks
      return (await hooks?.getGooglePushChannelProbe()) ?? { activeCount: -1 }
    })
    expect(probeBefore.activeCount).toBeLessThanOrEqual(0)

    // #when the user connects the provider through Settings → Calendar
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('tab', { name: 'Calendar' }).click()
    await page.getByRole('button', { name: /Connect Google Calendar/i }).click()

    // The OAuth popup is skipped because the refresh token is already seeded in keytar.
    // The runner starts, fans out ensureChannelForSource across the selected calendars,
    // and POSTs /calendar/channels + PATCHes resourceId on sync-server.
    await expect
      .poll(
        async () => {
          const probe = await electronApp.evaluate(async () => {
            const hooks = (
              globalThis as typeof globalThis & {
                __memryTestHooks?: { getGooglePushChannelProbe(): Promise<ChannelProbe> }
              }
            ).__memryTestHooks
            return hooks?.getGooglePushChannelProbe()
          })
          return probe?.activeCount ?? 0
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] }
      )
      .toBeGreaterThan(0)

    // #when the user disconnects
    await page.getByRole('button', { name: /Disconnect/i }).click()
    await page.getByRole('button', { name: /Confirm/i }).click()

    // #then every channel has been stopped on Google and deleted on sync-server
    await expect
      .poll(
        async () => {
          const probe = await electronApp.evaluate(async () => {
            const hooks = (
              globalThis as typeof globalThis & {
                __memryTestHooks?: { getGooglePushChannelProbe(): Promise<ChannelProbe> }
              }
            ).__memryTestHooks
            return hooks?.getGooglePushChannelProbe()
          })
          return probe?.activeCount ?? -1
        },
        { timeout: 15_000 }
      )
      .toBe(0)
  })

  test('webhook → WS broadcast → single-source sync (<10s e2e latency)', async ({
    page,
    electronApp
  }) => {
    const calendarId = process.env.GOOGLE_CALENDAR_E2E_CALENDAR_ID!
    const eventSummary = `Push-Channel E2E ${Date.now()}`

    // #given the provider is connected and at least one channel is registered
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('tab', { name: 'Calendar' }).click()
    await page.getByRole('button', { name: /Connect Google Calendar/i }).click()
    await expect
      .poll(
        async () => {
          const probe = await electronApp.evaluate(async () => {
            const hooks = (
              globalThis as typeof globalThis & {
                __memryTestHooks?: { getGooglePushChannelProbe(): Promise<ChannelProbe> }
              }
            ).__memryTestHooks
            return hooks?.getGooglePushChannelProbe()
          })
          return probe?.activeCount ?? 0
        },
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0)

    // #when an event is created directly on Google (outside Memry)
    const now = Date.now()
    const createdId = await electronApp.evaluate(
      async (_ctx, input) => {
        const hooks = (
          globalThis as typeof globalThis & {
            __memryTestHooks?: {
              createGoogleCalendarEventForE2E(input: {
                calendarId: string
                summary: string
                startMs: number
                endMs: number
              }): Promise<string>
            }
          }
        ).__memryTestHooks
        if (!hooks?.createGoogleCalendarEventForE2E) {
          throw new Error(
            'Missing __memryTestHooks.createGoogleCalendarEventForE2E — add it before enabling this suite.'
          )
        }
        return await hooks.createGoogleCalendarEventForE2E(input)
      },
      { calendarId, summary: eventSummary, startMs: now + 3_600_000, endMs: now + 7_200_000 }
    )

    // #then Memry picks up the event via the webhook within ~10 seconds
    // (this is well under the 30-minute push-backoff poll cadence, proving push actually fired)
    await page.getByRole('button', { name: 'Calendar' }).click()
    await expect(page.getByText(eventSummary)).toBeVisible({ timeout: 15_000 })

    // #cleanup — delete the test event so the calendar doesn't accumulate state across runs
    await electronApp.evaluate(
      async (_ctx, input) => {
        const hooks = (
          globalThis as typeof globalThis & {
            __memryTestHooks?: {
              deleteGoogleCalendarEventForE2E(input: {
                calendarId: string
                eventId: string
              }): Promise<void>
            }
          }
        ).__memryTestHooks
        await hooks?.deleteGoogleCalendarEventForE2E(input)
      },
      { calendarId, eventId: createdId }
    )
  })
})
