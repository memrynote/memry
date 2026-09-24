import {
  CALENDAR_MULTI_WRITER_MIN_APP_VERSION,
  GOOGLE_CALENDAR_PROVIDER,
  type CalendarWriterCompatDevice,
  type CalendarWriterCompatResponse
} from '@memry/contracts/calendar-api'
import { createLogger } from '../../lib/logger'
import { providerCapabilities } from './capabilities'

const log = createLogger('Calendar:WriterCompat')

/**
 * Why this exists (#1396). Sync payloads are end-to-end encrypted and
 * `provider` sits inside them, so the server cannot keep a CalDAV binding away
 * from an older build. An older build with Google connected treats that
 * binding as absent and pushes the same task to Google (double push), or reads
 * a CalDAV collection URL as a Google calendar id and fails every push. Only
 * the connect flow can prevent that, by listing the account's devices that are
 * too old and asking the user to update them or accept the risk.
 */

export interface RemoteDeviceForCompat {
  id: string
  name: string
  platform: string
  appVersion?: string | null
}

/**
 * Clients that never write to an external calendar: they neither push
 * bindings nor resolve `target_calendar_id`, so no version of them can double
 * push. iOS registers with a semver (`0.1.0`) that would always read as below
 * the desktop floor. Any other platform string is checked (fail closed).
 */
const NON_WRITER_PLATFORMS = new Set(['ios', 'android', 'web'])

export interface WriterCompatDeps {
  isSignedIn(): Promise<boolean>
  /** The account's live devices from `GET /devices`, or null when unreadable. */
  listDevices(): Promise<RemoteDeviceForCompat[] | null>
  currentDeviceId(): string | null
}

/** Same ordering as the sync server's `isVersionBelow`: numeric major.minor.patch. */
export function isAppVersionBelow(version: string, minimum: string): boolean {
  const parse = (value: string): number[] => value.split('.').map((part) => Number(part))
  const [aMajor, aMinor = 0, aPatch = 0] = parse(version)
  const [bMajor, bMinor = 0, bPatch = 0] = parse(minimum)
  if ([aMajor, aMinor, aPatch].some((part) => !Number.isFinite(part))) return true
  if (aMajor !== bMajor) return aMajor < bMajor
  if (aMinor !== bMinor) return aMinor < bMinor
  return aPatch < bPatch
}

/** Whether connecting this provider adds a second writer to the account. */
export function providerNeedsWriterCompatCheck(providerId: string): boolean {
  return providerId !== GOOGLE_CALENDAR_PROVIDER && providerCapabilities(providerId).supportsWrite
}

export async function checkProviderWriterCompat(
  providerId: string,
  deps: WriterCompatDeps
): Promise<CalendarWriterCompatResponse> {
  const base = { minVersion: CALENDAR_MULTI_WRITER_MIN_APP_VERSION }
  if (!providerNeedsWriterCompatCheck(providerId)) {
    return { ...base, required: false, verified: true, outdatedDevices: [] }
  }
  // Without a Memry account nothing syncs, so no other device can receive
  // this provider's bindings.
  if (!(await deps.isSignedIn())) {
    return { ...base, required: true, verified: true, outdatedDevices: [] }
  }

  let devices: RemoteDeviceForCompat[] | null
  try {
    devices = await deps.listDevices()
  } catch (error) {
    log.warn('Could not read the device list for the writer compatibility check', error)
    devices = null
  }
  if (!devices) return { ...base, required: true, verified: false, outdatedDevices: [] }

  const currentId = deps.currentDeviceId()
  const outdatedDevices: CalendarWriterCompatDevice[] = devices
    .filter((device) => device.id !== currentId)
    .filter((device) => !NON_WRITER_PLATFORMS.has(device.platform))
    .filter(
      (device) =>
        !device.appVersion ||
        isAppVersionBelow(device.appVersion, CALENDAR_MULTI_WRITER_MIN_APP_VERSION)
    )
    .map((device) => ({
      id: device.id,
      name: device.name,
      platform: device.platform,
      appVersion: device.appVersion ?? null
    }))
  return { ...base, required: true, verified: true, outdatedDevices }
}

/** A connect may proceed when nothing is at risk, or the user acknowledged the risk. */
export function writerCompatAllowsConnect(
  compat: CalendarWriterCompatResponse,
  acknowledged: boolean | undefined
): boolean {
  if (!compat.required) return true
  if (compat.verified && compat.outdatedDevices.length === 0) return true
  return acknowledged === true
}
