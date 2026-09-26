import type {
  FieldClockMap,
  SettingsSyncPayload,
  SyncedSettings
} from '@memry/contracts/settings-sync'
import { compare } from '@memry/sync-client/vector-clock'
import { mergeFields } from './field-merge'

export interface SettingsMergeResult {
  settings: SyncedSettings
  fieldClocks: FieldClockMap
  /** Some path compared `concurrent`; §6.9.0 requires re-queueing the result. */
  requeue: boolean
}

/**
 * Chapter 06 §6.9.0: every clocked path is arbitrated by §6.3's field rule
 * (`mergeFields`), over the union of both payloads' `fieldClocks` keys, on a
 * copy of the local settings. A key that is not an addressable path keeps its
 * union clock and arbitrates nothing.
 *
 * A winner with no value at the path leaves the local value in place, as
 * §6.3.2 row 10 does (#2383). Desktop parses settings with a closed schema, so
 * a build that does not model a path strips its value but keeps and echoes its
 * clock; removing on that echo would delete the setting on every device that
 * models it. Removal waits until desktop keeps unmodelled keys (#2183).
 *
 * Paths apply in sorted order so a clocked ancestor lands before its
 * descendants, the same order the Rust core's `BTreeSet` gives.
 */
export function mergeSettingsPayloads(
  local: SettingsSyncPayload,
  remote: SettingsSyncPayload
): SettingsMergeResult {
  const paths = [
    ...new Set([...Object.keys(local.fieldClocks), ...Object.keys(remote.fieldClocks)])
  ]
  paths.sort()

  const { merged, mergedFieldClocks } = mergeFields(
    flatten(local.settings, paths),
    flatten(remote.settings, paths),
    local.fieldClocks,
    remote.fieldClocks,
    paths
  )

  const settings = structuredClone(local.settings) as Record<string, unknown>
  for (const path of paths) {
    const segments = settingsPathSegments(path)
    if (!segments) continue
    const value = merged[path]
    if (value !== undefined) setSettingsPath(settings, segments, value)
  }

  return {
    settings: settings as SyncedSettings,
    fieldClocks: mergedFieldClocks,
    requeue: paths.some(
      (path) =>
        compare(local.fieldClocks[path] ?? {}, remote.fieldClocks[path] ?? {}) === 'concurrent'
    )
  }
}

/** `null` for `""` or a path with an empty segment such as `general.`. */
function settingsPathSegments(path: string): string[] | null {
  const segments = path.split('.')
  return segments.some((segment) => segment === '') ? null : segments
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function flatten(settings: SyncedSettings, paths: string[]): Record<string, unknown> {
  const flat: Record<string, unknown> = {}
  for (const path of paths) {
    const segments = settingsPathSegments(path)
    if (!segments) continue
    let node: unknown = settings
    for (const segment of segments) node = isRecord(node) ? node[segment] : undefined
    if (node !== undefined) flat[path] = node
  }
  return flat
}

export function setSettingsPath(
  settings: Record<string, unknown>,
  segments: string[],
  value: unknown
): void {
  let node = settings
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(node[segment])) node[segment] = {}
    node = node[segment] as Record<string, unknown>
  }
  node[segments[segments.length - 1]] = value
}
