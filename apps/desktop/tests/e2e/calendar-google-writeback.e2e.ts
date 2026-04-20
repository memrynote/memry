/**
 * Google Calendar write-back — Memry → Google operational verification.
 *
 * Counterpart to calendar-google-two-way-sync.e2e.ts (which covers the import
 * direction). This suite proves the push path works end-to-end against the
 * real Google Calendar API: insert a calendar_events row locally, invoke
 * pushSourceToGoogleCalendar via a test hook, then GET the event directly
 * from Google and assert the written fields match.
 *
 * Push-channel round-trip remains out of scope here (it needs Memry sync-server
 * auth on staging — see calendar-push-channels.e2e.ts). This suite exercises
 * pushSourceToGoogleCalendar directly, which has no isMemryUserSignedIn guard,
 * mirroring how the import test uses syncGoogleCalendarSource directly.
 *
 * Flow per test:
 *   1. seedGoogleCalendarTokens — keytar gets the refresh token
 *   2. connectGoogleCalendarForE2E — registers primary calendar as a source
 *   3. createMemryEventForWriteBackE2E — inserts a calendar_events row,
 *      targetCalendarId set to the primary calendar so the push lands there
 *      instead of auto-creating a "Memry" calendar on the test account
 *   4. pushMemryEventToGoogleForE2E — calls pushSourceToGoogleCalendar,
 *      returns the binding's remoteCalendarId/remoteEventId
 *   5. fetchGoogleEventForE2E — GET /calendar/v3/calendars/:id/events/:id
 *   6. assert title + start + end match
 *   7. deleteGoogleCalendarEventForE2E — cleans up the Google event in finally
 */
import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady } from './utils/electron-helpers'

const CREDS_PRESENT =
  process.env.GOOGLE_CALENDAR_E2E === '1' &&
  !!process.env.GOOGLE_CALENDAR_E2E_REFRESH_TOKEN &&
  !!process.env.GOOGLE_CALENDAR_E2E_CLIENT_ID

interface ConnectResult {
  accountId: string
  accountSourceId: string
  calendarSourceId: string
  primaryCalendarId: string
}

interface CreateMemryEventResult {
  sourceId: string
}

interface PushResult {
  remoteCalendarId: string
  remoteEventId: string
  remoteVersion: string | null
}

interface GoogleEventProbe {
  id: string
  summary: string | null
  start: { dateTime?: string | null; date?: string | null } | null
  end: { dateTime?: string | null; date?: string | null } | null
}

test.describe('Google Calendar write-back (Memry → Google direct push)', () => {
  test.skip(
    !CREDS_PRESENT,
    'Flag-gated: set GOOGLE_CALENDAR_E2E=1 plus GOOGLE_CALENDAR_E2E_{REFRESH_TOKEN,CLIENT_ID}. ' +
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

  test('pushes a locally-created calendar_event to Google via pushSourceToGoogleCalendar', async ({
    electronApp
  }) => {
    const eventTitle = `Write-back E2E ${Date.now()}`
    const now = Date.now()
    const startMs = now + 3_600_000
    const endMs = now + 7_200_000

    // #given connect has inserted the primary calendar as a selected source
    const connectResult = await electronApp.evaluate(async () => {
      const hooks = (
        globalThis as typeof globalThis & {
          __memryTestHooks?: { connectGoogleCalendarForE2E(): Promise<ConnectResult> }
        }
      ).__memryTestHooks
      return await hooks!.connectGoogleCalendarForE2E()
    })

    // #when a Memry-owned calendar_events row is created locally
    const created = await electronApp.evaluate(
      async (_ctx, input) => {
        const hooks = (
          globalThis as typeof globalThis & {
            __memryTestHooks?: {
              createMemryEventForWriteBackE2E(input: {
                title: string
                startMs: number
                endMs: number
                targetCalendarId: string
              }): Promise<CreateMemryEventResult>
            }
          }
        ).__memryTestHooks
        if (!hooks?.createMemryEventForWriteBackE2E) {
          throw new Error('Missing __memryTestHooks.createMemryEventForWriteBackE2E')
        }
        return await hooks.createMemryEventForWriteBackE2E(input)
      },
      {
        title: eventTitle,
        startMs,
        endMs,
        targetCalendarId: connectResult.primaryCalendarId
      }
    )

    expect(created.sourceId).toBeTruthy()

    // #when the push runs end-to-end via pushSourceToGoogleCalendar
    const pushed = await electronApp.evaluate(
      async (_ctx, input) => {
        const hooks = (
          globalThis as typeof globalThis & {
            __memryTestHooks?: {
              pushMemryEventToGoogleForE2E(input: { sourceId: string }): Promise<PushResult>
            }
          }
        ).__memryTestHooks
        if (!hooks?.pushMemryEventToGoogleForE2E) {
          throw new Error('Missing __memryTestHooks.pushMemryEventToGoogleForE2E')
        }
        return await hooks.pushMemryEventToGoogleForE2E(input)
      },
      { sourceId: created.sourceId }
    )

    expect(pushed.remoteCalendarId).toBe(connectResult.primaryCalendarId)
    expect(pushed.remoteEventId).toBeTruthy()

    try {
      // #then the event is actually on Google with the fields we wrote
      const googleEvent = await electronApp.evaluate(
        async (_ctx, input) => {
          const hooks = (
            globalThis as typeof globalThis & {
              __memryTestHooks?: {
                fetchGoogleEventForE2E(input: {
                  calendarId: string
                  eventId: string
                }): Promise<GoogleEventProbe>
              }
            }
          ).__memryTestHooks
          if (!hooks?.fetchGoogleEventForE2E) {
            throw new Error('Missing __memryTestHooks.fetchGoogleEventForE2E')
          }
          return await hooks.fetchGoogleEventForE2E(input)
        },
        { calendarId: pushed.remoteCalendarId, eventId: pushed.remoteEventId }
      )

      expect(googleEvent.summary).toBe(eventTitle)
      // Google Calendar stores event times at whole-second precision — it
      // silently drops milliseconds on events.insert/update round-trip. Compare
      // against the second-floored input rather than the raw ms so the test
      // matches the actual API contract.
      const secondsFloor = (ms: number): number => Math.floor(ms / 1000) * 1000
      expect(new Date(googleEvent.start?.dateTime ?? '').getTime()).toBe(secondsFloor(startMs))
      expect(new Date(googleEvent.end?.dateTime ?? '').getTime()).toBe(secondsFloor(endMs))
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
        { calendarId: pushed.remoteCalendarId, eventId: pushed.remoteEventId }
      )
    }
  })
})
