import {
  COVER_CREDIT_FRONTMATTER_KEY,
  COVER_CREDIT_URL_FRONTMATTER_KEY,
  COVER_FOCUS_FRONTMATTER_KEY,
  COVER_FOCUS_X_FRONTMATTER_KEY,
  COVER_FRONTMATTER_KEY,
  COVER_HEIGHT_FRONTMATTER_KEY,
  COVER_ZOOM_FRONTMATTER_KEY,
  isCoverCreditUrlValue,
  isCoverCreditValue,
  isCoverFocusValue,
  isCoverHeightValue,
  isCoverValue,
  isCoverZoomValue
} from '@memry/shared/cover-image'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Mirrors desktop's `isReservedFrontmatterKey` (apps/desktop/src/main/vault/frontmatter.ts):
// every other top-level key is a user property. Cover and writing-tools keys
// are reserved only when their value has the shape desktop writes.
const RESERVED_FRONTMATTER_KEYS = new Set(['tags', 'aliases', 'properties'])
const VALUE_GATED_FRONTMATTER_KEYS: ReadonlyMap<string, (value: unknown) => boolean> = new Map([
  [COVER_FRONTMATTER_KEY, isCoverValue as (value: unknown) => boolean],
  [COVER_FOCUS_FRONTMATTER_KEY, isCoverFocusValue as (value: unknown) => boolean],
  [COVER_FOCUS_X_FRONTMATTER_KEY, isCoverFocusValue as (value: unknown) => boolean],
  [COVER_ZOOM_FRONTMATTER_KEY, isCoverZoomValue as (value: unknown) => boolean],
  [COVER_HEIGHT_FRONTMATTER_KEY, isCoverHeightValue as (value: unknown) => boolean],
  [COVER_CREDIT_FRONTMATTER_KEY, isCoverCreditValue as (value: unknown) => boolean],
  [COVER_CREDIT_URL_FRONTMATTER_KEY, isCoverCreditUrlValue as (value: unknown) => boolean],
  // Desktop's writing-tools data. Its validator (`@memry/shared/writing-tools/markdown`)
  // does not load under Node type stripping, so any object value is reserved:
  // the CLI must never treat that data as a property and drop it on update.
  ['writing', isPlainRecord]
])

function isReservedFrontmatterKey(name: string, value: unknown): boolean {
  if (RESERVED_FRONTMATTER_KEYS.has(name)) return true
  return VALUE_GATED_FRONTMATTER_KEYS.get(name)?.(value) ?? false
}

// Properties are top-level user keys, as desktop writes them. The nested
// `properties:` envelope is a legacy format written by older CLI builds (#2975);
// it is still read, and top-level keys win on conflict.
export function propertiesFromFrontmatter(
  frontmatter: Record<string, unknown>
): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const nested = frontmatter.properties
  const sources = isPlainRecord(nested) ? [nested, frontmatter] : [frontmatter]
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && !isReservedFrontmatterKey(key, value)) properties[key] = value
    }
  }
  return properties
}

// Replace the note's property set: drop current property keys (root and the
// legacy envelope) and write the new ones as top-level keys.
export function frontmatterWithProperties(
  frontmatter: Record<string, unknown>,
  properties: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...frontmatter }
  delete next.properties
  for (const key of Object.keys(propertiesFromFrontmatter(frontmatter))) delete next[key]
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined && !isReservedFrontmatterKey(key, value)) next[key] = value
  }
  return next
}
