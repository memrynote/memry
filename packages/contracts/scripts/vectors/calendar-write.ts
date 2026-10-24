/**
 * Class: calendar-write (`calendar-write.json`, spec 007 CL070).
 *
 * What desktop writes to a calendar provider, imported for real:
 * `ical/ical-write.ts` (`eventToICalendar`, `patchICalendar`,
 * `excludeOccurrence`) for CalDAV objects, `google/mappers.ts`
 * (`mapCalendarEventToGoogleInput`) for the recurrence lines a push sends,
 * and `isAppVersionBelow` for the writer-compat notice (restated: its module
 * loads desktop's logger through Electron).
 *
 * Objects are compared per VEVENT property by the phone's tests, ignoring the
 * stamps (DTSTAMP, LAST-MODIFIED, CREATED) and the VTIMEZONE text: each side
 * writes the zone's rules its own way.
 */
import * as icalWrite from '../../../../apps/desktop/src/main/calendar/ical/ical-write.ts'
import * as googleMappers from '../../../../apps/desktop/src/main/calendar/google/mappers.ts'
import { CALENDAR_MULTI_WRITER_MIN_APP_VERSION } from '../../src/calendar-api.ts'
import { zoneTable } from './calendar-ical.ts'
import {
  EXCLUSIONS,
  NEW_OBJECTS,
  PATCHES,
  RECURRENCES,
  VERSIONS,
  WRITE_NOW,
  WRITE_ZONES
} from './calendar-write-cases.ts'

type IcalWrite = typeof icalWrite
type Mappers = typeof googleMappers
const writer: IcalWrite = (icalWrite as IcalWrite & { default?: IcalWrite }).default ?? icalWrite
const mappers: Mappers = (googleMappers as Mappers & { default?: Mappers }).default ?? googleMappers

// `writer-compat.ts` restated line for line.
const parseVersion = (value: string): number[] => value.split('.').map((part) => Number(part))

function isAppVersionBelow(version: string, minimum: string): boolean {
  const [aMajor, aMinor = 0, aPatch = 0] = parseVersion(version)
  const [bMajor, bMinor = 0, bPatch = 0] = parseVersion(minimum)
  if ([aMajor, aMinor, aPatch].some((part) => !Number.isFinite(part))) return true
  if (aMajor !== bMajor) return aMajor < bMajor
  if (aMinor !== bMinor) return aMinor < bMinor
  return aPatch < bPatch
}

type Input = Parameters<IcalWrite['eventToICalendar']>[0]
type Row = Parameters<Mappers['mapCalendarEventToGoogleInput']>[0]

export function buildCalendarWrite(): Record<string, unknown> {
  const now = new Date(WRITE_NOW)
  const fromMs = Date.UTC(2025, 0, 1)
  const toMs = Date.UTC(2028, 0, 1)
  return {
    description:
      "What desktop writes: CalDAV objects (new, patched, one occurrence excluded), a push's recurrence lines, and which app versions the writer-compat notice lists.",
    now: WRITE_NOW,
    zones: WRITE_ZONES.map((zone) => zoneTable(zone, fromMs, toMs)),
    newObjects: NEW_OBJECTS.map((c) => ({
      ...c,
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- fixture events are deliberately partial rows; the writer is fed what the phone sends; vectors:check pins the output
      expected: writer.eventToICalendar(c.event as unknown as Input, { uid: c.uid, now })
    })),
    patches: PATCHES.map((c) => ({
      ...c,
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- fixture events are deliberately partial rows; the writer is fed what the phone sends; vectors:check pins the output
      expected: writer.patchICalendar(c.raw, c.event as unknown as Input, {
        recurrenceId: c.recurrenceId,
        now
      })
    })),
    exclusions: EXCLUSIONS.map((c) => ({
      ...c,
      expected: writer.excludeOccurrence(c.raw, c.recurrenceId, now)
    })),
    recurrences: RECURRENCES.map((c) => ({
      ...c,
      expected:
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- fixture row is deliberately partial; the mapper is fed what the phone sends; vectors:check pins the output
        mappers.mapCalendarEventToGoogleInput({
          id: 'evt',
          title: 't',
          startAt: '2026-10-05T07:00:00.000Z',
          isAllDay: false,
          timezone: c.timezone,
          recurrenceRule: c.rule,
          recurrenceExceptions: c.exceptions
        } as unknown as Row).recurrence ?? null
    })),
    writerCompat: {
      minimum: CALENDAR_MULTI_WRITER_MIN_APP_VERSION,
      versions: VERSIONS.map((version) => ({
        version,
        below: isAppVersionBelow(version, CALENDAR_MULTI_WRITER_MIN_APP_VERSION)
      }))
    }
  }
}
