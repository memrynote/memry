import type {
  CalendarProviderCapabilities,
  ListProviderCalendarsResponse,
  SetDefaultProviderCalendarResponse
} from '@memry/contracts/calendar-api'
import type { DataDb } from '../../database/types'
import type { CalendarProviderAdapter } from './adapter'

/**
 * What a provider hands back once the user has finished its connect flow.
 * The caller turns this into the `calendar_sources` rows — id conventions and
 * sync bookkeeping are the engine's business, not the provider's.
 */
export interface ProviderConnectResult {
  accountId: string
  account: {
    remoteId: string
    title: string
    timezone: string | null
    email: string
  }
  primaryCalendar: {
    remoteId: string
    title: string
    timezone: string | null
    color: string | null
    isPrimary: boolean
  }
}

export interface CalendarProviderDefinition {
  readonly id: string
  readonly capabilities: CalendarProviderCapabilities

  /** An adapter bound to one connected account. */
  createAdapter(accountId: string): CalendarProviderAdapter

  /** Run the provider's own connect flow (OAuth window, URL prompt, …). */
  connect(input: { accountId?: string }): Promise<ProviderConnectResult>

  /** Forget one account's stored credentials. Must tolerate an unknown id. */
  disconnect(accountId: string): Promise<void>

  /** Accounts this provider currently has rows for. */
  listAccountIds(db: DataDb): string[]

  /** The account a provider-wide request (list calendars, push) routes to. */
  resolveDefaultAccountId(db: DataDb): string | null

  /** The provider's calendars, plus which one is the current default target. */
  listCalendars(db: DataDb): Promise<ListProviderCalendarsResponse>

  /** Persist the onboarding choice of default target calendar. */
  setDefaultCalendar(
    db: DataDb,
    input: { calendarId: string | null; markOnboardingComplete: boolean }
  ): SetDefaultProviderCalendarResponse

  /** Does any / this one account still hold usable local credentials? */
  hasLocalAuth(db: DataDb): Promise<boolean>
  hasAccountLocalAuth(accountId: string): Promise<boolean>

  /** Refresh the calendar list for one account into `calendar_sources`. */
  discoverSources(db: DataDb, accountId: string): Promise<void>

  /** Pull everything this provider has, now. */
  syncNow(db: DataDb): Promise<void>

  /** Re-run one `calendar_sources` row. */
  syncSource(db: DataDb, sourceId: string): Promise<void>

  startSyncRunner(): Promise<void>
  stopSyncRunner(): void
}

const providers = new Map<string, CalendarProviderDefinition>()

export function registerProvider(definition: CalendarProviderDefinition): void {
  providers.set(definition.id, definition)
}

export function getProvider(id: string): CalendarProviderDefinition | null {
  return providers.get(id) ?? null
}

export function listProviders(): CalendarProviderDefinition[] {
  return [...providers.values()]
}

export function getProviderCapabilities(id: string): CalendarProviderCapabilities | null {
  return providers.get(id)?.capabilities ?? null
}

/**
 * The message an unregistered provider gets. Kept as one function so every
 * call site says exactly the same thing — it is asserted verbatim by the IPC
 * tests, and the renderer surfaces it as-is.
 */
export function unsupportedProviderMessage(id: string): string {
  return `Unsupported calendar provider: ${id}`
}
