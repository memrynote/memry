import {
  APPLE_EVENTKIT_CALENDAR_PROVIDER,
  GOOGLE_CALENDAR_PROVIDER
} from '@memry/contracts/calendar-api'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import type { SyncedSettings } from '@memry/contracts/settings-sync'
import {
  deleteSetting as removeSettingRow,
  getSetting,
  setSetting as writeSettingRow
} from '../database/queries/settings'
import type { DataDb } from '../database/types'
import { createLogger } from '../lib/logger'
import { setSettingWriteListener } from '../settings/settings-store'
import {
  getSettingsSyncManager,
  initSettingsSyncManager,
  type SettingsSyncManager
} from '@memry/sync-client/settings-sync'

// The runtime imports settings sync through here so the calendar mirror
// starts with it; `sync/runtime.ts` sits on its line ceiling.
export { resetSettingsSyncManager } from '@memry/sync-client/settings-sync'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { DEFAULT_WRITE_TARGET_SETTINGS_KEY } from './provider/write-routing'

/**
 * Two-way calendar settings (spec 007 D3a).
 *
 * The calendar groups live in the device-local settings table, where every
 * screen and the provider runtime read them. This module mirrors the keys
 * that must follow the user across devices into settings sync, one dotted
 * path and one field clock per leaf, and writes merged remote values back into
 * the local groups:
 *
 * | local group                   | synced path                          |
 * | ----------------------------- | ------------------------------------ |
 * | `calendar`                    | `calendar.weekStartDay`, `calendar.showNotesOnCalendar` |
 * | `calendar.google`             | `calendar.google.<key>` (five keys)  |
 * | `calendar.<provider>`         | `calendar.<provider>.<key>`          |
 * | `calendar.defaultWriteTarget` | `calendar.defaultWriteTarget` (whole value) |
 *
 * Device-local by nature and never mirrored: the sidebar day-panel click
 * settings, This Mac's provider group (its events never leave the Mac), and
 * provider secrets and cursors, which are not settings.
 *
 * Compat: an older desktop whose schema lacks a key strips it from the synced
 * value but keeps its field clock, so it re-uploads the clock with no value and
 * the merge (`SettingsSyncManager.mergeRemote`) keeps the newer device's value.
 */

const log = createLogger('CalendarSettingsSync')

const CALENDAR_KEYS = ['weekStartDay', 'showNotesOnCalendar'] as const
const GOOGLE_KEYS = [
  'defaultTargetCalendarId',
  'onboardingCompleted',
  'promoteConfirmDismissed',
  'pushEventsToGoogle',
  'agentReadEventsConsent'
] as const
const PROVIDER_KEYS = ['agentReadEventsConsent', 'pushEventsToProvider'] as const

interface SyncedField {
  path: string
  value: unknown
}

export interface CalendarSettingsSyncTarget {
  updateField(fieldPath: string, value: unknown, deviceId: string): void
  getPayload(): { settings: SyncedSettings; fieldClocks: Record<string, unknown> }
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function parseValue(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/** The leaf keys a local group mirrors, or null for a group that stays local. */
function groupLeaves(key: string): readonly string[] | null {
  if (key === 'calendar') return CALENDAR_KEYS
  if (key === `calendar.${GOOGLE_CALENDAR_PROVIDER}`) return GOOGLE_KEYS
  if (!key.startsWith('calendar.') || key === DEFAULT_WRITE_TARGET_SETTINGS_KEY) return null
  const provider = key.slice('calendar.'.length)
  if (provider.includes('.') || provider === APPLE_EVENTKIT_CALENDAR_PROVIDER) return null
  return PROVIDER_KEYS
}

/** The synced leaves a local write changed. */
export function changedCalendarFields(
  key: string,
  before: string | null,
  after: string | null
): SyncedField[] {
  if (key === DEFAULT_WRITE_TARGET_SETTINGS_KEY) {
    const previous = parseValue(before)
    const next = after === null ? null : parseValue(after)
    if (next === undefined || JSON.stringify(previous) === JSON.stringify(next)) return []
    return [{ path: key, value: next }]
  }
  const leaves = groupLeaves(key)
  if (!leaves) return []
  const previous = parseObject(before) ?? {}
  const next = parseObject(after) ?? {}
  const fields: SyncedField[] = []
  for (const leaf of leaves) {
    if (!Object.prototype.hasOwnProperty.call(next, leaf)) continue
    if (JSON.stringify(previous[leaf]) === JSON.stringify(next[leaf])) continue
    fields.push({ path: `${key}.${leaf}`, value: next[leaf] })
  }
  return fields
}

/** The settings-store listener: hand each changed leaf to settings sync. */
export function mirrorCalendarSettingWrite(
  target: CalendarSettingsSyncTarget,
  key: string,
  before: string | null,
  after: string | null
): void {
  for (const field of changedCalendarFields(key, before, after)) {
    target.updateField(field.path, field.value, 'local')
  }
}

function syncedValueAt(settings: SyncedSettings, path: string): unknown {
  let current: unknown = settings
  for (const part of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** Every local group key that currently holds calendar settings. */
function localGroupKeys(db: DataDb): string[] {
  const keys = [
    'calendar',
    `calendar.${GOOGLE_CALENDAR_PROVIDER}`,
    DEFAULT_WRITE_TARGET_SETTINGS_KEY
  ]
  for (const provider of ['caldav', 'ics']) keys.push(`calendar.${provider}`)
  return keys.filter((key) => getSetting(db, key) !== null)
}

/**
 * Seed once (D3a): a key this device has set locally but that no device has
 * synced yet is pushed from the local value, so an existing install keeps its
 * choice. A key some device already synced is left to the merge.
 */
export function seedCalendarSyncedSettings(db: DataDb, target: CalendarSettingsSyncTarget): number {
  const { settings, fieldClocks } = target.getPayload()
  let seeded = 0
  for (const key of localGroupKeys(db)) {
    for (const field of changedCalendarFields(key, null, getSetting(db, key))) {
      if (Object.prototype.hasOwnProperty.call(fieldClocks, field.path)) continue
      if (syncedValueAt(settings, field.path) !== undefined) continue
      target.updateField(field.path, field.value, 'local')
      seeded += 1
    }
  }
  if (seeded > 0) log.info('Seeded calendar settings into settings sync', { seeded })
  return seeded
}

function writeLocalGroup(db: DataDb, key: string, updates: Record<string, unknown>): void {
  const current = parseObject(getSetting(db, key)) ?? {}
  const changed = Object.entries(updates).filter(
    ([leaf, value]) => JSON.stringify(current[leaf]) !== JSON.stringify(value)
  )
  if (changed.length === 0) return
  const next = { ...current, ...Object.fromEntries(changed) }
  writeSettingRow(db, key, JSON.stringify(next))
  broadcastToAllWindows(SettingsChannels.events.CHANGED, {
    key,
    value: Object.fromEntries(changed)
  })
}

/**
 * Writes merged synced calendar values into the local groups every reader
 * uses. Raw writes, so they do not echo back into settings sync. A key the
 * merged value omits leaves the local one alone.
 */
export function applyMergedCalendarSettings(db: DataDb, merged: SyncedSettings['calendar']): void {
  if (!merged || typeof merged !== 'object') return
  const calendar = merged as Record<string, unknown>
  const pick = (
    source: Record<string, unknown>,
    keys: readonly string[]
  ): Record<string, unknown> =>
    Object.fromEntries(
      keys
        .filter((k) => Object.prototype.hasOwnProperty.call(source, k) && source[k] !== undefined)
        .map((k) => [k, source[k]])
    )

  writeLocalGroup(db, 'calendar', pick(calendar, CALENDAR_KEYS))

  for (const [name, value] of Object.entries(calendar)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    if (name === 'defaultWriteTarget') continue
    const key = `calendar.${name}`
    const leaves = groupLeaves(key)
    if (!leaves) continue
    writeLocalGroup(db, key, pick(value as Record<string, unknown>, leaves))
  }

  if (Object.prototype.hasOwnProperty.call(calendar, 'defaultWriteTarget')) {
    const target = calendar.defaultWriteTarget
    const current = parseValue(getSetting(db, DEFAULT_WRITE_TARGET_SETTINGS_KEY))
    if (target === undefined || JSON.stringify(current ?? null) === JSON.stringify(target ?? null))
      return
    // Locally a cleared default is an absent row (routing then falls back to
    // Google's own default); on the wire it is `null`.
    if (target === null) removeSettingRow(db, DEFAULT_WRITE_TARGET_SETTINGS_KEY)
    else writeSettingRow(db, DEFAULT_WRITE_TARGET_SETTINGS_KEY, JSON.stringify(target))
    broadcastToAllWindows(SettingsChannels.events.CHANGED, {
      key: DEFAULT_WRITE_TARGET_SETTINGS_KEY,
      value: target ?? null
    })
  }
}

/**
 * `initSettingsSyncManager` plus the calendar mirror (spec 007 D3a): every
 * later local write of a mirrored group reaches settings sync, and keys only
 * this device has set are seeded once. The listener resolves the manager at
 * write time, so after `resetSettingsSyncManager` it does nothing.
 */
export function initSettingsSync(
  deps: Parameters<typeof initSettingsSyncManager>[0]
): SettingsSyncManager {
  const manager = initSettingsSyncManager(deps)
  setSettingWriteListener((_db, key, before, after) => {
    const current = getSettingsSyncManager()
    if (current) mirrorCalendarSettingWrite(current, key, before, after)
  })
  try {
    seedCalendarSyncedSettings(deps.db as unknown as DataDb, manager)
  } catch (error) {
    log.warn('Seeding calendar settings into settings sync failed', error)
  }
  return manager
}
