import matter from 'gray-matter'
import { dump, load, CORE_SCHEMA, type DumpOptions } from 'js-yaml'

export interface ParsedMarkdownNote {
  frontmatter: Record<string, unknown>
  content: string
}

// YAML 1.2 core parse — Obsidian's semantics: '2026-07-05' and 'yes' stay
// strings, never Date/boolean (gray-matter's bundled js-yaml 3 is YAML 1.1)
const MATTER_OPTIONS = {
  engines: {
    yaml: {
      parse: (src: string): object => {
        const data = load(src, { schema: CORE_SCHEMA })
        return data && typeof data === 'object' ? (data as object) : {}
      }
    }
  }
}

export function parseMarkdownNote(raw: string): ParsedMarkdownNote {
  const parsed = matter(raw, MATTER_OPTIONS)
  return {
    frontmatter: parsed.data,
    content: parsed.content.trim()
  }
}

// Obsidian-style emit — mirrors apps/desktop/src/main/vault/frontmatter-emit.ts
const DUMP_OPTIONS: DumpOptions = {
  schema: CORE_SCHEMA, // no YAML 1.1 timestamp resolver — keeps '2026-07-05' plain
  indent: 2,
  noArrayIndent: false, // lists indent 2 under the key
  flowLevel: -1, // block style everywhere, never `[a, b]`
  quotingType: '"', // Obsidian quotes with double quotes
  forceQuotes: false, // ...and only when syntactically required
  lineWidth: -1, // default 80 folds long scalars into multi-line plain style
  noRefs: true, // never emit anchors/aliases
  noCompatMode: true, // don't quote YAML 1.1-isms (`yes`, `on`)
  styles: { '!!null': 'empty' } // empty property => `key:` like Obsidian
}

/**
 * Normalize values for emit — mirrors the desktop emitter
 * (apps/desktop/src/main/vault/frontmatter-emit.ts). Date instances become
 * Obsidian's date formats: YYYY-MM-DD, or YYYY-MM-DDTHH:MM:SS (no millis, no Z)
 * when there is a time component. Uses LOCAL components so a Date at local
 * midnight in a non-UTC zone is not misclassified as a datetime (and shifted a
 * day). Recurses arrays/objects.
 */
function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) {
    const pad = (n: number): string => String(n).padStart(2, '0')
    const year = value.getFullYear()
    const month = pad(value.getMonth() + 1)
    const day = pad(value.getDate())
    const dateOnly =
      value.getHours() === 0 &&
      value.getMinutes() === 0 &&
      value.getSeconds() === 0 &&
      value.getMilliseconds() === 0
    if (dateOnly) return `${year}-${month}-${day}`
    const hours = pad(value.getHours())
    const minutes = pad(value.getMinutes())
    const seconds = pad(value.getSeconds())
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`
  }
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeValue(v)])
    )
  }
  return value
}

export function writeMarkdownNote(frontmatter: Record<string, unknown>, content: string): string {
  // One key per dump call: keeps entry order (no JS integer-key hoisting)
  // LIMITATION (#8): Object.entries still hoists integer-like keys (e.g. a
  // property named `2024`) to the front — shared with the desktop emitter.
  const entries = Object.entries(frontmatter).filter(([, v]) => v !== undefined)
  // No keys → no YAML block at all
  if (entries.length === 0) {
    return content.trim()
  }
  const body = entries
    .map(([key, value]) => {
      const normalized = normalizeValue(value)
      const dumped = dump({ [key]: normalized }, DUMP_OPTIONS)
      // js-yaml emits `key: ` (trailing space) for the empty-null style; only
      // strip in that case. The `m` flag would otherwise eat significant
      // trailing spaces on interior lines of a `|-` block scalar.
      return normalized === null ? dumped.replace(/[ \t]+$/gm, '') : dumped
    })
    .join('')
  // Strip only trailing newlines (not all whitespace) to match desktop's
  // serializeNote byte-for-byte.
  return `---\n${body}---\n${content.trim()}`.replace(/(?:\r?\n)+$/g, '')
}

const RESERVED_FRONTMATTER_KEYS = new Set(['tags', 'aliases'])

/**
 * Extract custom properties: top-level non-reserved keys are primary; a
 * legacy nested `properties:` mapping merges in after them (top-level wins).
 */
export function extractNoteProperties(
  frontmatter: Record<string, unknown>,
  reserved: ReadonlySet<string> = RESERVED_FRONTMATTER_KEYS
): Record<string, unknown> {
  const nested =
    frontmatter.properties &&
    typeof frontmatter.properties === 'object' &&
    !Array.isArray(frontmatter.properties)
      ? (frontmatter.properties as Record<string, unknown>)
      : undefined

  const properties: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === 'properties' && nested) continue
    if (!reserved.has(key) && value !== undefined) {
      properties[key] = value
    }
  }

  if (nested) {
    for (const [key, value] of Object.entries(nested)) {
      if (!(key in properties) && !reserved.has(key) && value !== undefined) {
        properties[key] = value
      }
    }
  }

  return properties
}

/**
 * Rebuild frontmatter with the property record as top-level keys — mirrors
 * apps/desktop/src/main/vault/frontmatter.ts. Reserved keys keep their
 * original positions; the legacy nested `properties:` mapping is dropped;
 * key order: original top-level, then legacy nested, then new keys.
 */
export function applyPropertiesToFrontmatter(
  frontmatter: Record<string, unknown>,
  properties: Record<string, unknown>,
  reserved: ReadonlySet<string> = RESERVED_FRONTMATTER_KEYS
): Record<string, unknown> {
  const nested =
    frontmatter.properties &&
    typeof frontmatter.properties === 'object' &&
    !Array.isArray(frontmatter.properties)
      ? (frontmatter.properties as Record<string, unknown>)
      : undefined
  const remaining = new Set(Object.keys(properties).filter((key) => !reserved.has(key)))
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(frontmatter)) {
    if (reserved.has(key)) {
      result[key] = value
      continue
    }
    if (key === 'properties' && nested) continue
    if (remaining.has(key)) {
      result[key] = properties[key]
      remaining.delete(key)
    }
  }

  if (nested) {
    for (const key of Object.keys(nested)) {
      if (remaining.has(key)) {
        result[key] = properties[key]
        remaining.delete(key)
      }
    }
  }

  for (const key of remaining) {
    result[key] = properties[key]
  }

  return result
}

export function wordCount(content: string): number {
  const words = content.trim().split(/\s+/).filter(Boolean)
  return words.length
}

export function snippet(content: string): string {
  return stripMarkup(content).replace(/\s+/g, ' ').trim().slice(0, 180)
}

function stripMarkup(markdown: string): string {
  // Remove HTML comments in a loop until stable: one pass can re-form `<!-- -->`
  // from the text left on either side of a removed comment.
  let withoutComments = markdown
  let previous: string
  do {
    previous = withoutComments
    withoutComments = withoutComments.replace(/<!--[\s\S]*?-->/g, '') // memry block/colors/file markers + any HTML comment
  } while (withoutComments !== previous)

  return withoutComments
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2') // wiki link w/ alias → alias
    .replace(/\[\[([^\]]+)\]\]/g, '$1') // wiki link → target
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '')) // fenced code → inner text
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // image → alt
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // link → text
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '') // bullet markers
    .replace(/^\s*\d+\.\s+/gm, '') // ordered markers
    .replace(/[*_~]{1,3}/g, '') // emphasis/strike
}
