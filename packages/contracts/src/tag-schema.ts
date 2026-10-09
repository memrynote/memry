/**
 * The tag schema: what a tag definition carries beyond its name, colour and
 * icon, and the resolved model every reader works from.
 *
 * PERSISTED AND SYNCED: stored as one versioned object in
 * `tag_definitions.schema` and sent as the `tag_definition` payload key
 * `schema` (chapter 13 §13.7.7.1). Loose objects: keys a newer build adds
 * survive a parse and a local edit, because edits spread the stored object.
 *
 *   { "t": 3,
 *     "fields": [{ "name": "Company", "relation": { "target": "company", "many": false, "inverse": "People" } },
 *                { "name": "Role" }],
 *     "template": { "id": "tpl_8f2", "autofill": true },
 *     "extends": null,
 *     "preset": "person" }
 *
 * A field carries no type: the vault-wide property definition owns it. Only a
 * relation's config lives on the tag, because property definitions cannot hold
 * `relation` (older desktops wipe `.memry/properties.md` on an unknown type).
 */
import { z } from 'zod'
import type { PropertyType, SelectOption } from './property-types'

export const PRESET_KEYS = ['person', 'company', 'meeting', 'book'] as const
export type PresetKey = (typeof PRESET_KEYS)[number]

export function isPresetKey(value: unknown): value is PresetKey {
  return typeof value === 'string' && (PRESET_KEYS as readonly string[]).includes(value)
}

/** Every field type is an existing property type. `project` is reserved and never a field. */
export type FieldType = Exclude<PropertyType, 'project'>

export interface RelationConfig {
  /** Lowercase tag the picker is restricted to; null = any note. */
  target: string | null
  many: boolean
  /** Label of the inverse list on the target ("People"); null = the source tag's name. */
  inverse: string | null
}

export const TagFieldWire = z.looseObject({
  name: z.string().min(1).max(200),
  relation: z
    .looseObject({
      target: z.string().nullable().optional(),
      many: z.boolean().optional(),
      inverse: z.string().max(100).nullable().optional()
    })
    .nullable()
    .optional()
})
export type TagFieldStored = z.infer<typeof TagFieldWire>

export const TagSchemaWire = z.looseObject({
  t: z.number().int().nonnegative(),
  fields: z.array(TagFieldWire).optional(),
  template: z
    .looseObject({ id: z.string().min(1), autofill: z.boolean().optional() })
    .nullable()
    .optional(),
  extends: z.string().nullable().optional(),
  /** An open string, so a preset key a newer build adds round-trips. */
  preset: z.string().nullable().optional()
})
export type TagSchemaStored = z.infer<typeof TagSchemaWire>

/** What "remove everything" stores: a versioned empty schema, never SQL NULL once a schema existed. */
export const EMPTY_TAG_SCHEMA_BODY = {
  fields: [],
  template: null,
  extends: null,
  preset: null
} as const

/**
 * Frontmatter keys that are never note properties, so never field names.
 * Compared case-insensitively. Mirrors `RESERVED_FRONTMATTER_KEYS` and the
 * value-gated cover and writing keys in `apps/desktop/src/main/vault/frontmatter.ts`,
 * plus `project`, whose type is always `project`.
 */
export const RESERVED_FIELD_NAMES: readonly string[] = [
  'tags',
  'aliases',
  'properties',
  'project',
  'cover',
  'coverFocus',
  'coverFocusX',
  'coverZoom',
  'coverHeight',
  'coverCredit',
  'coverCreditUrl',
  'writing'
]

export function isReservedFieldName(name: string): boolean {
  const folded = name.trim().toLowerCase()
  return RESERVED_FIELD_NAMES.some((reserved) => reserved.toLowerCase() === folded)
}

export interface ResolvedField {
  name: string
  type: FieldType
  /** select, multiselect and status options, from the property definition. */
  options?: SelectOption[]
  showOnCalendar?: boolean
  relation: RelationConfig | null
  /** Lowercase tag whose schema lists it. Not the resolved tag = inherited, edited on that tag. */
  definedBy: string
}

/** One resolved tag. Only tags whose schema column is non-NULL resolve. */
export interface ResolvedTag {
  /** Stored display casing. */
  name: string
  /** Lowercase identity. */
  key: string
  color: string
  icon: string | null
  /** False when the stored schema did not parse (a newer build wrote it): shown, never edited. */
  editable: boolean
  ownFields: ResolvedField[]
  /** Nearest ancestor first; names listed closer are dropped. */
  inherited: Array<{ from: string; fields: ResolvedField[] }>
  /** Farthest ancestor first, own fields last. Settings list and default column order. */
  effectiveFields: ResolvedField[]
  hasFields: boolean
  /** The parent as stored, lowercased; may name a missing tag. */
  extends: string | null
  /** The resolved chain, nearest first, cut at the first repeat or missing definition. */
  ancestors: string[]
  template: { id: string; autofill: boolean; inheritedFrom: string | null } | null
  /** Own preset, else the nearest ancestor's. */
  preset: PresetKey | null
  ownPreset: PresetKey | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameTag(value: unknown, key: string): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === key
}

/**
 * §13.7.7.2. Points `extends` and every relation `target` that name `from` at
 * `to` (null on delete), on a stored schema of any shape. Returns null when
 * nothing names `from`; otherwise the rewritten schema with `t + 1`. Every
 * other key, nested ones included, is kept. The Rust core's
 * `domain/tag_schema_refs.rs` implements the same rule, pinned by the
 * `tag-schema-refs` vectors.
 */
export function rewriteSchemaReference(
  schema: Readonly<Record<string, unknown>>,
  from: string,
  to: string | null
): Record<string, unknown> | null {
  const fromKey = from.trim().toLowerCase()
  const toKey = to === null ? null : to.trim().toLowerCase()
  if (toKey === fromKey) return null
  let changed = false
  const next: Record<string, unknown> = { ...schema }
  if (sameTag(schema.extends, fromKey)) {
    next.extends = toKey
    changed = true
  }
  if (Array.isArray(schema.fields)) {
    next.fields = schema.fields.map((field: unknown) => {
      if (!isRecord(field) || !isRecord(field.relation)) return field
      if (!sameTag(field.relation.target, fromKey)) return field
      changed = true
      return { ...field, relation: { ...field.relation, target: toKey } }
    })
  }
  if (!changed) return null
  const t = schema.t
  next.t = (typeof t === 'number' && Number.isSafeInteger(t) && t >= 0 ? t : 0) + 1
  return next
}
