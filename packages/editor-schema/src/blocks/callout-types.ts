/**
 * Which `> [!name]` markers are callouts: the built-in types plus the ones the
 * user defined in settings (#3207).
 *
 * The definitions are vault-wide synced settings, not part of the note, so the
 * parser cannot receive them with the markdown. Each process keeps the current
 * set here and `readCalloutRun` consults it. A marker whose name is in neither
 * list is not claimed and stays an ordinary quote, byte-for-byte: that is what
 * another app, or a build older than this feature, sees for every custom type.
 */

/**
 * The first four are the original types. The rest use the common Markdown
 * callout names, so an imported `> [!note]` reads as a callout here too. The `type` prop
 * is a free string in the CRDT, and builds before these types render an
 * unknown one as `info` and write it back unchanged.
 */
export const CALLOUT_TYPE_VALUES = [
  'info',
  'warning',
  'error',
  'success',
  'note',
  'abstract',
  'todo',
  'tip',
  'important',
  'question',
  'example',
  'quote',
  'bug'
] as const

export type CalloutTypeValue = (typeof CALLOUT_TYPE_VALUES)[number]

/** A user-defined callout type. `name` is the text between `[!` and `]`. */
export interface CalloutTypeDefinition {
  name: string
  label: string
  /** `#rrggbb`, lowercase. */
  color: string
  /** An icon id the renderer knows; an unknown id draws the default icon. */
  icon: string
}

/** What may sit between `[!` and `]`: lowercase, so it can never match `[!NOTE]`. */
export const CALLOUT_TYPE_NAME_REGEX = /^[a-z][a-z0-9_-]{0,31}$/
const COLOR_REGEX = /^#[0-9a-fA-F]{6}$/
export const CALLOUT_LABEL_MAX_LENGTH = 40
export const CALLOUT_ICON_MAX_LENGTH = 32

const BUILT_IN = new Set<string>(CALLOUT_TYPE_VALUES)
let custom: ReadonlyMap<string, CalloutTypeDefinition> = new Map()

/** Replace this process's custom definitions. Idempotent. */
export function setCalloutTypeDefinitions(definitions: readonly CalloutTypeDefinition[]): void {
  custom = new Map(definitions.map((definition) => [definition.name, definition]))
}

export function getCalloutTypeDefinitions(): CalloutTypeDefinition[] {
  return [...custom.values()]
}

/** Whether `[!name]` reads as a callout in this process. */
export function isCalloutTypeName(name: string): boolean {
  return BUILT_IN.has(name) || custom.has(name)
}

export function isBuiltInCalloutType(name: string): boolean {
  return BUILT_IN.has(name)
}

/**
 * Definitions out of the synced `editor.calloutTypes` map (name -> definition,
 * `null` once deleted). Settings cross builds and devices, so a bad entry is
 * dropped rather than failing the rest, and a name that shadows a built-in is
 * dropped so a definition can never change how `> [!info]` parses.
 */
export function sanitizeCalloutTypeDefinitions(raw: unknown): CalloutTypeDefinition[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []

  const definitions: CalloutTypeDefinition[] = []
  for (const [name, entry] of Object.entries(raw)) {
    if (!CALLOUT_TYPE_NAME_REGEX.test(name) || BUILT_IN.has(name)) continue
    if (typeof entry !== 'object' || entry === null) continue
    const fields: Record<string, unknown> = entry
    const { label, color, icon } = fields
    if (typeof color !== 'string' || !COLOR_REGEX.test(color)) continue
    if (typeof icon !== 'string' || icon === '' || icon.length > CALLOUT_ICON_MAX_LENGTH) continue
    definitions.push({
      name,
      label:
        typeof label === 'string' && label.trim() !== ''
          ? label.trim().slice(0, CALLOUT_LABEL_MAX_LENGTH)
          : name,
      color: color.toLowerCase(),
      icon
    })
  }
  return definitions.toSorted((a, b) => a.name.localeCompare(b.name))
}
