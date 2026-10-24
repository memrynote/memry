import {
  CALLOUT_TYPE_NAME_REGEX,
  sanitizeCalloutTypeDefinitions,
  setCalloutTypeDefinitions,
  type CalloutTypeDefinition
} from '@memry/editor-schema/callout-types'
import type { DataDb } from '../database/types'
import { getSetting, setSetting } from '../database/queries/settings'
import { syncSettingsMapEntryUpdates } from './runtime-effects'
import { createLogger } from '../lib/logger'

const log = createLogger('CalloutTypesStore')

/** Data-DB `settings` key holding the custom callout types as a JSON name -> definition map. */
export const CALLOUT_TYPES_SETTINGS_KEY = 'editor.calloutTypes'

function toMap(
  definitions: readonly CalloutTypeDefinition[]
): Record<string, CalloutTypeDefinition> {
  return Object.fromEntries(definitions.map((definition) => [definition.name, definition]))
}

/**
 * The user's custom callout types, and the parser's view of them: every read
 * refreshes this process's registry, so the markdown parser cannot disagree
 * with what the settings UI shows. Unreadable JSON reads as "no custom types".
 */
export function readCalloutTypes(db: DataDb): CalloutTypeDefinition[] {
  const raw = getSetting(db, CALLOUT_TYPES_SETTINGS_KEY)
  let definitions: CalloutTypeDefinition[] = []
  if (raw) {
    try {
      definitions = sanitizeCalloutTypeDefinitions(JSON.parse(raw))
    } catch (err) {
      log.warn(`Failed to parse stored ${CALLOUT_TYPES_SETTINGS_KEY}:`, err)
    }
  }
  setCalloutTypeDefinitions(definitions)
  return definitions
}

function persist(db: DataDb, definitions: CalloutTypeDefinition[]): void {
  setSetting(db, CALLOUT_TYPES_SETTINGS_KEY, JSON.stringify(toMap(definitions)))
  setCalloutTypeDefinitions(definitions)
}

/**
 * Replace the custom types and enqueue the difference for sync.
 *
 * One field path per type (`editor.calloutTypes.<name>`), so two devices adding
 * different types both keep theirs. A removed type syncs as `null`: the clock
 * has to carry the delete to beat a stale remote definition.
 */
export function writeCalloutTypes(db: DataDb, input: unknown): CalloutTypeDefinition[] {
  const previous = readCalloutTypes(db)
  const entries = Array.isArray(input)
    ? input.filter((d): d is { name: string } => typeof d?.name === 'string')
    : []
  const next = sanitizeCalloutTypeDefinitions(Object.fromEntries(entries.map((d) => [d.name, d])))
  persist(db, next)

  const before = toMap(previous)
  const after = toMap(next)
  const changed: Record<string, CalloutTypeDefinition | null> = {}
  for (const name of Object.keys(before)) if (!(name in after)) changed[name] = null
  for (const [name, definition] of Object.entries(after)) {
    if (JSON.stringify(before[name]) !== JSON.stringify(definition)) changed[name] = definition
  }
  syncSettingsMapEntryUpdates('editor', 'calloutTypes', changed, (name) =>
    CALLOUT_TYPE_NAME_REGEX.test(name)
  )
  return next
}

/**
 * Fold an inbound synced map into the stored types. Merged, never replaced:
 * settings sync carries only entries written since a device learned to sync
 * them, and replacing would drop a type this device defined before that.
 */
export function applyMergedCalloutTypes(
  db: DataDb,
  incoming: Record<string, unknown>
): CalloutTypeDefinition[] {
  const merged = toMap(readCalloutTypes(db))
  for (const [name, entry] of Object.entries(incoming)) {
    if (entry === null) delete merged[name]
    else {
      const [valid] = sanitizeCalloutTypeDefinitions({ [name]: entry })
      if (valid) merged[name] = valid
    }
  }
  const next = sanitizeCalloutTypeDefinitions(merged)
  persist(db, next)
  return next
}
