import {
  DEFAULT_STATUS_CATEGORIES,
  type SelectOption,
  type StatusCategories
} from '@memry/contracts/property-types'
import type { VaultDb } from '@/db/index'
import { createLogger } from '@/lib/logger'
import type { MobilePropertyType } from './note-ops'

const log = createLogger('PropertyDefinitions')

/**
 * A vault-wide property definition, as it reaches this device.
 *
 * `property_definition` rows carry the type and the option colours that used to
 * exist only in the desktop's `.memry/properties.md`. Without them mobile had
 * to guess a property's type from its value, which made `area: Work` a text
 * field and threw away the fact that `Work` is indigo.
 */
export interface MobilePropertyDefinition {
  name: string
  type: MobilePropertyType
  /** Flat, in picker order. A status property's categories are flattened here too. */
  options: SelectOption[]
  /** Present only for `status`, which the picker groups by category. */
  categories?: StatusCategories
}

const KNOWN_TYPES: readonly MobilePropertyType[] = [
  'text',
  'number',
  'checkbox',
  'date',
  'url',
  'status',
  'select',
  'multiselect',
  'relation',
  'project'
]

function toType(raw: unknown): MobilePropertyType {
  return KNOWN_TYPES.includes(raw as MobilePropertyType) ? (raw as MobilePropertyType) : 'text'
}

function isOption(value: unknown): value is SelectOption {
  const option = value as SelectOption | null
  return (
    typeof option?.value === 'string' && option.value.length > 0 && typeof option.color === 'string'
  )
}

/**
 * The row's `options` column, decoded.
 *
 * It is one TEXT column holding two different shapes: a bare option array, or
 * `{ categories }` for a status property. That is how the desktop writes it, so
 * that is what has to be read — the alternative is a second column and a
 * migration on a table that is already replicating.
 */
function decodeOptions(
  type: MobilePropertyType,
  raw: unknown
): Pick<MobilePropertyDefinition, 'options' | 'categories'> {
  let parsed: unknown = null
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      log.warn('Property definition options are not JSON; treating the property as untyped')
    }
  }

  if (type === 'status') {
    const categories =
      (parsed as { categories?: StatusCategories } | null)?.categories ?? DEFAULT_STATUS_CATEGORIES
    return {
      categories,
      options: Object.values(categories).flatMap((category) => category.options.filter(isOption))
    }
  }

  return { options: Array.isArray(parsed) ? parsed.filter(isOption) : [] }
}

/**
 * Every property definition the vault has replicated, by name.
 *
 * A property with no row here is not an error — it is a `text`, `number` or
 * `date` the desktop never needed to define, and `inferPropertyType` reads it
 * off the value exactly as the desktop does when its own definition is missing.
 */
export async function readPropertyDefinitions(
  db: VaultDb
): Promise<Map<string, MobilePropertyDefinition>> {
  const rows = await db.getAllAsync<{ id: string; payload: string | null }>(
    `SELECT id, payload FROM sync_items WHERE type = 'property_definition' AND deleted_at IS NULL`
  )
  const definitions = new Map<string, MobilePropertyDefinition>()
  for (const row of rows) {
    if (!row.payload) continue
    try {
      const payload = JSON.parse(row.payload) as { type?: unknown; options?: unknown }
      const type = toType(payload.type)
      definitions.set(row.id, { name: row.id, type, ...decodeOptions(type, payload.options) })
    } catch {
      log.warn('Property definition payload is not JSON; skipping', { name: row.id })
    }
  }
  return definitions
}
