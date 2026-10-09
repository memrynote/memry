/**
 * Property type resolution for indexed note properties: inference from a
 * frontmatter value, and the precedence ladder every caller resolves through.
 *
 * @module vault/property-type
 */

import { PROJECT_PROPERTY_KEY, type PropertyType } from '@memry/contracts/property-types'
import { isRelationValue } from '@memry/contracts/relation-uri'

/**
 * Check if a string is a valid ISO 8601 date.
 */
function isISODate(value: string): boolean {
  // Match YYYY-MM-DD or full ISO datetime
  const isoDatePattern = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/
  if (!isoDatePattern.test(value)) {
    return false
  }
  const date = new Date(value)
  return !isNaN(date.getTime())
}

/**
 * Check if a string is a valid URL.
 */
function isURL(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Infer property type from a value.
 * T008: Used when syncing externally-edited properties that don't have
 * a pre-existing type definition.
 *
 * @param name - Property name (checked against reserved keys, e.g. `project`)
 * @param value - Property value to infer type from
 * @returns Inferred property type
 */
export function inferPropertyType(name: string, value: unknown): PropertyType {
  // Reserved: `project` carries an array of project names. Inference would fall
  // through to the array branch below and flatten it to text.
  if (name === PROJECT_PROPERTY_KEY) {
    return 'project'
  }

  // Boolean -> checkbox
  if (typeof value === 'boolean') {
    return 'checkbox'
  }

  // Number with contextual hints
  if (typeof value === 'number') {
    return 'number'
  }

  // Array of memry:// URIs -> relation (must precede the array->text fallback)
  if (isRelationValue(value)) {
    return 'relation'
  }

  // Array -> text (arrays no longer supported, convert to JSON string)
  if (Array.isArray(value)) {
    return 'text'
  }

  // String with format detection
  if (typeof value === 'string') {
    // Check for ISO date format
    if (isISODate(value)) {
      return 'date'
    }
    // Check for URL format
    if (isURL(value)) {
      return 'url'
    }
    return 'text'
  }

  // Default to text for unknown types
  return 'text'
}

/**
 * Resolve a property's type. This is the single ladder every caller uses, in
 * strict precedence order:
 *
 *   1. **Reserved name** — `project` is system-owned. Both the index DB and the
 *      canonical (data) DB persist a `property_definitions.type` row per name,
 *      and a stale `{ name: 'project', type: 'text' }` row (written before the
 *      feature existed, e.g. a vault imported from Obsidian) must not override
 *      the reserved key.
 *   2. **Structural value** — an array of `memry://` URIs IS a relation,
 *      whatever a stored definition claims. This one is not cosmetic: a
 *      relation's first write is the empty default `[]`, `isRelationValue([])`
 *      is false, so inference yields `text` and that gets written as the
 *      definition row. Every later read would then deserialize the URI array
 *      as a raw JSON string, the renderer would stop treating the row as a
 *      relation, and the next property edit would round-trip that string into
 *      the vault file — dropping the `property_refs` rows, the graph edge and
 *      the backlink with it. Deriving from the value is idempotent and
 *      self-heals notes already damaged that way.
 *   3. **Stored definition**, when there is one.
 *   4. **Inference** from the value.
 *
 * Callers pass in whatever stored definition type they already looked up
 * (index or canonical), so this stays storage-agnostic.
 *
 * Note for callers that persist the result: `relation` must never be written
 * to a definition store — `PropertyDefinitionSchema` has no member for it, so
 * a persisted `relation` makes `.memry/properties.md` fail `safeParse`, which
 * discards *every* definition in the file. `isPersistableDefinitionType`
 * guards that.
 *
 * @param name - Property name (checked against reserved keys, e.g. `project`)
 * @param value - Property value, checked structurally and passed to inferFn
 * @param definitionType - Type from a stored property definition, if any
 * @param inferFn - Fallback inference when nothing earlier in the ladder matches
 * @returns Resolved property type
 */
export function resolvePropertyType(
  name: string,
  value: unknown,
  definitionType: PropertyType | undefined,
  inferFn: (name: string, value: unknown) => PropertyType
): PropertyType {
  if (name === PROJECT_PROPERTY_KEY) {
    return 'project'
  }

  if (isRelationValue(value)) {
    return 'relation'
  }

  if (definitionType) {
    return definitionType
  }

  return inferFn(name, value)
}
