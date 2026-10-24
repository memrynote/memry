/**
 * Pure helpers for `tag-schema.ts`: tag SQL predicates, the palette, error
 * wording and the object-search ranking and subtitle rules.
 */
import { sql, type AnyColumn, type SQL } from 'drizzle-orm'
import type { PropertyType } from '@memry/contracts/property-types'
import { parseRelationValue } from '@memry/contracts/relation-uri'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type { SchemaEditError } from '@memry/app-core/tag-schema'
import { foldTag, tagKey } from '@memry/shared/tag-fold'

// Same palette as desktop's `getOrCreateTag`: a new definition is minted
// unauthored, so it never repaints the tag on another device.
export const TAG_COLOR_PALETTE = [
  'rose',
  'pink',
  'fuchsia',
  'purple',
  'violet',
  'indigo',
  'blue',
  'sky',
  'cyan',
  'teal',
  'emerald',
  'green',
  'lime',
  'yellow',
  'amber',
  'orange',
  'stone',
  'slate',
  'gray',
  'zinc',
  'neutral',
  'warm',
  'red',
  'coral'
]

export const DEFAULT_OPTION_COLOR = 'gray'
export const MAX_NOTES = 10000

export function tagIs(column: AnyColumn, tag: string): SQL {
  return sql`tag_fold(${column}) = ${foldTag(tag)}`
}

export function tagIn(column: AnyColumn, tags: Iterable<string>): SQL {
  const keys = [...new Set([...tags].map(foldTag))]
  if (keys.length === 0) return sql`0`
  return sql`tag_fold(${column}) IN (${sql.join(
    keys.map((key) => sql`${key}`),
    sql`, `
  )})`
}

// English text of desktop's `errors:tagFields.*` messages.
// oxlint-disable-next-line typescript/consistent-return -- switch over error codes; an unknown code falls through unchanged
export function schemaEditFailure(error: SchemaEditError): Error {
  switch (error.code) {
    case 'reserved-name':
      return new Error(`"${error.name}" is reserved and cannot be a field name`)
    case 'duplicate-field':
      return new Error(`#${error.definedBy} already has a field named "${error.name}"`)
    case 'unknown-field':
      return new Error(`This tag has no field named "${error.name}"`)
    case 'inherited-field':
      return new Error(`"${error.name}" comes from #${error.definedBy}. Edit it there`)
    case 'cycle':
      return new Error(`#${error.parent} already takes its fields from this tag`)
    case 'unreadable-schema':
      return new Error('A newer version of Memry changed this tag. Update Memry to edit it')
  }
}

export function parseOptions(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Lowercase with diacritics removed, so "ahm" finds "Ahmet" and "s" finds
 * "ş". Turkish dotted and dotless i both fold to "i" (desktop `foldForSearch`).
 */
export function foldForSearch(text: string): string {
  return text
    .replace(/[İIı]/g, 'i')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
}

export function matchRank(title: string, query: string): number | null {
  if (query === '') return 0
  const folded = foldForSearch(title)
  if (folded.startsWith(query)) return 0
  if (folded.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(query))) return 1
  return folded.includes(query) ? 2 : null
}

export const TEXT_LIKE: ReadonlySet<PropertyType> = new Set(['text', 'url', 'select', 'status'])

const filled = (value: unknown): value is string | number =>
  (typeof value === 'string' && value.trim() !== '') || typeof value === 'number'

export function subtitleFor(
  values: Record<string, unknown>,
  entry: ResolvedTag | undefined,
  titleOf: (id: string) => string | undefined
): string[] {
  const texts: string[] = []
  let relation: string | undefined
  for (const field of entry?.effectiveFields ?? []) {
    const value = values[field.name]
    if (field.type === 'relation') {
      relation ??= parseRelationValue(value)
        .filter((ref) => ref.kind === 'note')
        .map((ref) => titleOf(ref.id))
        .find((title) => title !== undefined)
    } else if (TEXT_LIKE.has(field.type) && filled(value)) {
      texts.push(String(value))
    }
  }
  return [texts[0], relation ?? texts[1]].filter((part): part is string => part !== undefined)
}

export function fieldOwner(
  tags: readonly string[],
  field: string,
  resolved: ReadonlyMap<string, ResolvedTag>,
  relationOnly: boolean
): { tag: string; label: string | null } | null {
  for (const tag of tags) {
    const match = resolved
      .get(tagKey(tag))
      ?.effectiveFields.find(
        (candidate) => candidate.name === field && (!relationOnly || candidate.relation)
      )
    if (match) {
      return {
        tag: match.definedBy,
        label: match.relation?.inverse ?? resolved.get(match.definedBy)?.name ?? null
      }
    }
  }
  return null
}
