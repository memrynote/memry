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

interface ChannelProbe {
  activeCount: number
}

test.describe('Google calendar push channels (M4b round-trip)', () => {
  // Push channels require the desktop to be signed in to Memry's sync server
  // (so it can POST /calendar/channels with a valid bearer token). The E2E
  // vault bootstraps against a local test sync server, but the push webhook
  // has to land on a publicly-reachable sync-server (staging). Until a
  // pre-provisioned staging user with its signing key is wired into the E2E
  // env, these tests cannot execute end-to-end. The data-plane pull path is
  // covered without Memry auth by calendar-google-two-way-sync.e2e.ts; the
  // data-plane push path is covered by calendar-google-writeback.e2e.ts.
  test.skip(true, 'Requires staging Memry sync-auth bootstrap — tracked separately')

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

    // #when the provider is connected via hook. We bypass the "Connect" UI button because
    // clicking it invokes the real OAuth loopback server and opens the system browser, which
    // is not reachable from Playwright. connectGoogleCalendarForE2E replicates the exact
    // post-OAuth steps CONNECT_PROVIDER performs (upsert account+calendar sources, start the
    // sync runner) against the already-seeded refresh token — same end-state, no popup.
    await electronApp.evaluate(async () => {
      const hooks = (
        globalThis as typeof globalThis & {
          __memryTestHooks?: { connectGoogleCalendarForE2E(): Promise<unknown> }
        }
      ).__memryTestHooks
      if (!hooks?.connectGoogleCalendarForE2E) {
        throw new Error(
          'Missing __memryTestHooks.connectGoogleCalendarForE2E — rebuild after updating test-hooks.ts'
        )
      }
      await hooks.connectGoogleCalendarForE2E()
    })

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

    // #when the user disconnects through the real UI (⌘+, → Integrations → Disconnect).
    // Disconnect doesn't need OAuth — it just revokes tokens and drains channels — so this
    // half of the connect/disconnect UX is exercisable end-to-end.
    await page.keyboard.press('Meta+,')
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    await page.getByRole('button', { name: 'Integrations', exact: true }).click()
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()

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
    await electronApp.evaluate(async () => {
      const hooks = (
        globalThis as typeof globalThis & {
          __memryTestHooks?: { connectGoogleCalendarForE2E(): Promise<unknown> }
        }
      ).__memryTestHooks
      await hooks?.connectGoogleCalendarForE2E()
    })
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
    await page.getByRole('button', { name: 'Calendar', exact: true }).click()
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
