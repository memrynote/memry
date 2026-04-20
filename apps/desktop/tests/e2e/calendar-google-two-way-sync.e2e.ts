/**
 * Google Calendar two-way sync — operational verification.
 *
 * Covers the import path (Google → Memry) end-to-end against the real Google Calendar
 * API, without relying on the push-channel layer. The push-channel test suite
 * (calendar-push-channels.e2e.ts) requires Memry sync-server auth so that the desktop
 * can POST to /calendar/channels; this suite verifies the data-plane pull path that
 * works the moment Google auth is in place.
 *
 * Flow per test:
 *   1. seedGoogleCalendarTokens — keytar gets the refresh token
 *   2. connectGoogleCalendarForE2E — same post-OAuth side-effects as CONNECT_PROVIDER
 *      (account + calendar sources inserted, sync runner kicked). Does NOT drive the
 *      real OAuth loopback.
 *   3. createGoogleCalendarEventForE2E — creates an event directly on Google via REST
 *   4. syncGoogleCalendarSourceForE2E — pulls Google → local DB synchronously
 *   5. listCalendarExternalEventsForE2E — probes local DB to confirm the event was imported
 *   6. deleteGoogleCalendarEventForE2E — cleans up the test event
 *
 * Flag-gated behind the same env block the push-channel suite uses so the tests skip
 * cleanly when creds aren't wired.
 */
import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

const CREDS_PRESENT =
  process.env.GOOGLE_CALENDAR_E2E === '1' &&
  !!process.env.GOOGLE_CALENDAR_E2E_REFRESH_TOKEN &&
  !!process.env.GOOGLE_CALENDAR_E2E_CLIENT_ID &&
  !!process.env.GOOGLE_CALENDAR_E2E_CALENDAR_ID

interface ConnectResult {
  accountId: string
  accountSourceId: string
  calendarSourceId: string
  primaryCalendarId: string
}

interface ExternalEventProbe {
  id: string
  remoteEventId: string
  title: string
  startAt: string
  endAt: string | null
}

test.describe('Google Calendar two-way sync (direct-pull verification)', () => {
  test.skip(
    !CREDS_PRESENT,
    'Flag-gated: set GOOGLE_CALENDAR_E2E=1 plus GOOGLE_CALENDAR_E2E_{REFRESH_TOKEN,CLIENT_ID,CALENDAR_ID}. ' +
      'See apps/desktop/tests/e2e/calendar-push-channels.e2e.ts header for the full var list.'
  )

  test.beforeEach(async ({ page, electronApp }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)

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
          throw new Error('Missing __memryTestHooks.seedGoogleCalendarTokens')
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

  test('imports a Google-side event into calendar_external_events via direct sync', async ({
    electronApp
  }) => {
    const eventSummary = `Two-way-sync E2E ${Date.now()}`
    const now = Date.now()

    // #given connect has inserted the calendar source (hook replicates post-OAuth steps)
    const connectResult = await electronApp.evaluate(async () => {
      const hooks = (
        globalThis as typeof globalThis & {
          __memryTestHooks?: { connectGoogleCalendarForE2E(): Promise<ConnectResult> }
        }
      ).__memryTestHooks
      if (!hooks?.connectGoogleCalendarForE2E) {
        throw new Error('Missing __memryTestHooks.connectGoogleCalendarForE2E')
      }
      return await hooks.connectGoogleCalendarForE2E()
    })

    expect(connectResult.calendarSourceId).toBeTruthy()
    expect(connectResult.primaryCalendarId).toBeTruthy()

    // #when an event is created directly on Google
    const createdEventId = await electronApp.evaluate(
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
        return await hooks!.createGoogleCalendarEventForE2E(input)
      },
      {
        calendarId: connectResult.primaryCalendarId,
        summary: eventSummary,
        startMs: now + 3_600_000,
        endMs: now + 7_200_000
      }
    )

    try {
      // #when the desktop pulls from Google via the real sync-service (no Memry auth required)
      await electronApp.evaluate(
        async (_ctx, input) => {
          const hooks = (
            globalThis as typeof globalThis & {
              __memryTestHooks?: {
                syncGoogleCalendarSourceForE2E(input: { sourceId: string }): Promise<void>
              }
            }
          ).__memryTestHooks
          await hooks!.syncGoogleCalendarSourceForE2E(input)
        },
        { sourceId: connectResult.calendarSourceId }
      )

      // #then the event is persisted in calendar_external_events with the expected title
      const events = await electronApp.evaluate(
        async (_ctx, input) => {
          const hooks = (
            globalThis as typeof globalThis & {
              __memryTestHooks?: {
                listCalendarExternalEventsForE2E(input: {
                  sourceId: string
                }): Promise<ExternalEventProbe[]>
              }
            }
          ).__memryTestHooks
          return await hooks!.listCalendarExternalEventsForE2E(input)
        },
        { sourceId: connectResult.calendarSourceId }
      )

      expect(events.find((e) => e.remoteEventId === createdEventId)).toMatchObject({
        remoteEventId: createdEventId,
        title: eventSummary
      })
    } finally {
      // #cleanup — always delete, even if assertions fail, so staging doesn't accumulate test events
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
        { calendarId: connectResult.primaryCalendarId, eventId: createdEventId }
      )
    }
  })
})
