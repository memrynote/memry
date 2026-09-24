import type {
  CalendarProviderCapabilities,
  CalendarProviderConnection,
  CalendarProviderMutationResponse,
  DiscoverProviderCalendarsResponse,
  CalendarProviderRequest,
  ListProviderCalendarsResponse,
  RetryCalendarSourceSyncResponse,
  SetDefaultProviderCalendarInput,
  SetDefaultProviderCalendarResponse
} from '@memry/contracts/calendar-api'
import type { CalendarBinding } from '@memry/db-schema/schema/calendar-bindings'
import type { CalendarSource } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb } from '../../database'
import type { CalendarSyncTarget } from '../types'
import { isProviderAvailableOn } from './capabilities'
import type { WriteRoute } from './write-routing'

/**
 * What a writable provider exposes to the write path: reconcile one Memry
 * item with its remote calendar (create, update, or delete when the item no
 * longer belongs on a calendar). Called only for the provider the write
 * route picked (#2372).
 */
export interface ProviderWriter {
  syncLocalSource(
    db: DataDb,
    target: CalendarSyncTarget,
    route: WriteRoute
  ): Promise<CalendarBinding | null>
}

/**
 * One calendar provider as the IPC surface and the engine see it (#1392). The
 * handlers dispatch through this instead of branching on provider ids, so a
 * new provider is a new definition, not a new branch at every call site.
 */
export interface ProviderDefinition {
  readonly id: string
  readonly capabilities: CalendarProviderCapabilities
  connect(db: DataDb, input: CalendarProviderRequest): Promise<CalendarProviderMutationResponse>
  disconnect(db: DataDb, input: CalendarProviderRequest): Promise<CalendarProviderMutationResponse>
  refresh(db: DataDb, input: CalendarProviderRequest): Promise<CalendarProviderMutationResponse>
  /** Whether this device holds credentials for any account of the provider. */
  hasAnyLocalAuth(db: DataDb): Promise<boolean>
  /** Whether this device holds credentials for one account. */
  hasAccountLocalAuth(db: DataDb, accountId: string): Promise<boolean>
  /** Why an account without usable local auth needs a reconnect, when the provider can tell. */
  accountReconnectReason?(db: DataDb, accountId: string): Promise<'missing' | 'rejected' | null>
  /**
   * The user switched one of the provider's calendars on or off. The source
   * row is already saved; this reconciles the mirror and any runtime state.
   */
  onSelectionChanged(db: DataDb, before: CalendarSource, after: CalendarSource): void
  /** Re-run sync for one calendar source. */
  retrySource(db: DataDb, source: CalendarSource): Promise<RetryCalendarSourceSyncResponse>
  /** Writable calendars for target/default selection. Omitted = none. */
  listCalendars?(db: DataDb): Promise<ListProviderCalendarsResponse>
  setDefaultCalendar?(
    db: DataDb,
    input: SetDefaultProviderCalendarInput
  ): SetDefaultProviderCalendarResponse
  /** The push path. Only providers with `supportsWrite` are ever asked. */
  writer?: ProviderWriter
  /** Run discovery with a connection and report what it found, saving nothing. */
  discover?(connection: CalendarProviderConnection): Promise<DiscoverProviderCalendarsResponse>
}

const providers = new Map<string, ProviderDefinition>()

export function registerProvider(definition: ProviderDefinition): void {
  providers.set(definition.id, definition)
}

/**
 * The provider with this id, when it exists on this platform. A provider whose
 * `platforms` exclude the current OS is treated exactly like an unknown one.
 */
export function getProvider(
  providerId: string,
  platform: string = process.platform
): ProviderDefinition | null {
  const definition = providers.get(providerId)
  if (!definition || !isProviderAvailableOn(definition.capabilities, platform)) return null
  return definition
}

/** Every provider available on this platform, in registration order. */
export function listProviders(platform: string = process.platform): ProviderDefinition[] {
  return [...providers.values()].filter((definition) =>
    isProviderAvailableOn(definition.capabilities, platform)
  )
}

/** Test seam: forget every registration. */
export function resetProviderRegistry(): void {
  providers.clear()
}

/** The error every provider operation has returned for an unknown provider. Keep it byte-identical. */
export function unsupportedProviderError(providerId: string): string {
  return `Unsupported calendar provider: ${providerId}`
}
