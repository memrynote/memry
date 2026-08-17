/**
 * Frontmatter parsing and serialization for markdown notes.
 * Uses gray-matter for YAML frontmatter handling.
 *
 * @module vault/frontmatter
 */

import matter from 'gray-matter'
import path from 'path'
import {
  splitFrontmatterBlock,
  serializeParsedMarkdownNote,
  writeMarkdownNote,
  type Eol
} from '@memry/app-core/markdown'
import { generateNoteId, isValidNoteId } from '../lib/id'
import { isRelationValue } from '@memry/contracts/relation-uri'
import { splitWikiTarget } from '@memry/shared/wiki-target'

// ============================================================================
// Types
// ============================================================================

/**
 * User frontmatter keys of a note. Every key is a plain user property;
 * Memry only interprets `tags` and `aliases` (Obsidian-defined semantics).
 * Legacy Memry keys (id, title, created, modified, emoji, localOnly) found in
 * files are plain user properties too — never interpreted, never rewritten.
 */
export interface NoteFrontmatter {
  tags?: string[]
  aliases?: string[]
  [key: string]: unknown // Allow custom properties
}

/**
 * Filesystem stats used to derive in-memory created/modified defaults.
 */
export interface ParseNoteStats {
  birthtime?: Date
  mtime?: Date
}

/**
 * Result of parsing a markdown file with frontmatter.
 */
export interface ParsedNote {
  /** Raw user frontmatter keys, verbatim (tags/aliases normalized to arrays) */
  frontmatter: NoteFrontmatter
  /** Raw body substring — never trimmed; `rawFrontmatterBlock + content` is the file. */
  content: string
  /** Whether frontmatter was present in the original file */
  hadFrontmatter: boolean
  /**
   * Exact original substring from byte 0 (BOM included) through the closing
   * `---` line and its EOL, or null when the file had no frontmatter.
   */
  rawFrontmatterBlock: string | null
  /**
   * YAML parse failure message when the frontmatter block could not be read,
   * else null. On failure `frontmatter` is empty and the body is still parsed —
   * the note stays usable and indexable instead of failing whole.
   */
  frontmatterError: string | null
  eol: Eol
  hadTrailingNewline: boolean
  /**
   * In-memory defaults — never written back to the file. Callers that know
   * the note from the sidecar DBs should prefer the cached values.
   */
  id: string
  title: string
  created: string
  modified: string
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a markdown file content into frontmatter and body.
 * Identity and dates are in-memory defaults only: a fresh id, title from the
 * filename, created/modified from fs stats when provided (else now).
 *
 * @param rawContent - Raw file content including frontmatter
 * @param filePath - Optional file path for extracting title from filename
 * @param stats - Optional fs stats for created/modified defaults
 * @returns Parsed note with user frontmatter and in-memory defaults
 */
export function parseNote(
  rawContent: string,
  filePath?: string,
  stats?: ParseNoteStats
): ParsedNote {
  const { block, body } = splitFrontmatterBlock(rawContent)
  // Foreign vaults hold arbitrary YAML; a block we cannot parse must not cost
  // the note its body (it would vanish from search, graph and backlinks — #844).
  // The raw block is kept verbatim, so writeback preserves the broken bytes
  // unless the user actually edits frontmatter.
  let data: Record<string, unknown> = {}
  let frontmatterError: string | null = null
  if (block) {
    try {
      // The `{}` options bypass gray-matter's content-keyed cache, which would
      // otherwise leak `data` mutations into later parses of identical content.
      data = matter(block, {}).data as Record<string, unknown>
    } catch (error) {
      frontmatterError = error instanceof Error ? error.message : String(error)
    }
  }
  const hadFrontmatter = Object.keys(data).length > 0
  const now = new Date().toISOString()

  // Normalize tags to array (read-side only, never written back)
  if (data.tags && !Array.isArray(data.tags)) {
    data.tags = [stringifyScalar(data.tags)]
  }

  // Normalize aliases to array (read-side only, never written back)
  if (data.aliases && !Array.isArray(data.aliases)) {
    data.aliases = [stringifyScalar(data.aliases)]
  }

  return {
    frontmatter: data as NoteFrontmatter,
    content: body,
    hadFrontmatter,
    rawFrontmatterBlock: block,
    frontmatterError,
    eol: rawContent.includes('\r\n') ? '\r\n' : '\n',
    hadTrailingNewline: /\r?\n$/.test(rawContent),
    id: generateNoteId(),
    title: filePath ? extractTitleFromPath(filePath) : 'Untitled',
    created: stats?.birthtime?.toISOString() ?? now,
    modified: stats?.mtime?.toISOString() ?? now
  }
}

/** Foreign YAML can put any scalar here; objects need JSON, not '[object Object]'. */
function stringifyScalar(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value)
}

/**
 * Extract a display title from a file path: the verbatim basename without
 * the `.md` extension. The file path is the note's identity — the title
 * round-trips to the filename exactly.
 *
 * @param filePath - File path (can be relative or absolute)
 * @returns Verbatim basename without extension
 */
export function extractTitleFromPath(filePath: string): string {
  return path.basename(filePath, '.md')
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Serialize a NEW note file. Writes exactly the keys given (minus `undefined`
 * values); when no keys remain, returns the bare content with no YAML block.
 * New files get LF endings and a single trailing newline. Existing files must
 * go through serializeParsedNote instead so unedited bytes survive.
 *
 * @param frontmatter - User frontmatter keys
 * @param content - Markdown content (without frontmatter)
 * @returns Complete markdown file content
 */
export function serializeNote(frontmatter: NoteFrontmatter, content: string): string {
  return writeMarkdownNote(frontmatter, content)
}

export interface SerializeParsedNoteOptions {
  /** Only when true is the frontmatter block re-stringified; otherwise the raw block is emitted verbatim. */
  frontmatterEdited: boolean
}

/**
 * Serialize an EXISTING note back to file content. Anything the user didn't
 * change stays byte-identical: an unedited body (`content === parsed.content`)
 * and an unedited frontmatter block are emitted verbatim. An edited body gets
 * its EOLs converted to the file's dominant EOL and the file's final-newline
 * presence re-applied.
 */
export function serializeParsedNote(
  parsed: ParsedNote,
  content: string,
  options: SerializeParsedNoteOptions
): string {
  return serializeParsedMarkdownNote(parsed, content, options)
}

// ============================================================================
// Validation & Utilities
// ============================================================================

/**
 * Check if a note ID is valid and properly formatted.
 *
 * @param id - ID to validate
 * @returns True if valid note ID format
 */
export function validateNoteId(id: string): boolean {
  return isValidNoteId(id)
}

/**
 * Extract all wiki-style links from markdown content.
 * Matches [[Link Title]] and [[Link Title|Display Text]] patterns.
 *
 * `[[Note#Heading]]` yields `Note`: this table answers "which notes does this
 * note point at", and a heading link points at the note. Before that, the whole
 * string went in as a title, resolved to nothing, and the note it named never
 * listed the link as a backlink. The graph view has always read these targets
 * this way (`wikilinks` in @memry/app-core/graph), so this makes the two link
 * pipelines agree rather than introducing a second reading.
 *
 * The cost is the `Sprint #4` case: a note really called that is indexed here
 * under `Sprint`. Navigation and hover still reach it — they fall back to the
 * raw title against the database, which this function has no access to.
 *
 * Existing vaults keep their old rows until each note is next projected; no
 * reindex is forced for a backlink row.
 *
 * @param content - Markdown content
 * @returns Array of link targets
 */
export function extractWikiLinks(content: string): string[] {
  const linkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
  const links = new Set<string>()
  let match

  while ((match = linkPattern.exec(content)) !== null) {
    const { note, heading } = splitWikiTarget(match[1])
    // `[[#Heading]]` addresses the note it sits in — a self-link, not an edge.
    if (heading !== null && !note) continue
    links.add(heading !== null ? note : match[1].trim())
  }

  return Array.from(links)
}

/**
 * Extract all tags from frontmatter, preserving the case the user typed.
 * Deduplicates case-insensitively (first occurrence wins).
 *
 * @param frontmatter - Parsed frontmatter
 * @returns Array of trimmed tag strings
 */
export function extractTags(frontmatter: NoteFrontmatter): string[] {
  if (!frontmatter.tags || !Array.isArray(frontmatter.tags)) {
    return []
  }

  const byKey = new Map<string, string>()
  for (const raw of frontmatter.tags) {
    const tag = String(raw).trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, tag)
  }
  return [...byKey.values()]
}

/**
 * Extract inline #tag patterns from markdown body text.
 * Strips code blocks and inline code first, then matches tags
 * preceded by whitespace or start-of-string.
 *
 * Mirrors the editor's HASH_TAG_PATTERN from hash-tag.tsx.
 *
 * @param content - Markdown body (post-frontmatter)
 * @returns Deduplicated tag names (case preserved, case-insensitive dedupe)
 */
export function extractInlineTagsFromMarkdown(content: string): string[] {
  const withoutCode = content.replace(/```[\s\S]*?```/g, '')
  const withoutInlineCode = withoutCode.replace(/`[^`]+`/g, '')

  const byKey = new Map<string, string>()
  const pattern = /#([a-zA-Z][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*)/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(withoutInlineCode)) !== null) {
    const precedingChar = match.index > 0 ? withoutInlineCode[match.index - 1] : ''
    if (precedingChar && !/\s/.test(precedingChar)) continue
    const key = match[1].toLowerCase()
    if (!byKey.has(key)) byKey.set(key, match[1])
  }

  return Array.from(byKey.values())
}

/**
 * Calculate word count from markdown content.
 * Excludes code blocks and frontmatter.
 *
 * @param content - Markdown content (without frontmatter)
 * @returns Word count
 */
export function calculateWordCount(content: string): number {
  // Remove code blocks
  const withoutCode = content.replace(/```[\s\S]*?```/g, '')

  // Remove inline code
  const withoutInlineCode = withoutCode.replace(/`[^`]+`/g, '')

  // Count words (split on whitespace)
  const words = withoutInlineCode.split(/\s+/).filter((word) => word.length > 0)

  return words.length
}

/**
 * Generate a content hash for change detection.
 * Uses a simple hash of the full file content.
 *
 * @param content - Full file content including frontmatter
 * @returns Hash string
 */
/**
 * Incremental form of {@link generateContentHash}.
 *
 * djb2 folds one character at a time, so a file read in chunks hashes to the
 * same value as the same file read whole. Rename detection compares the hash of
 * a newly added file against the hash cached for a deleted one, and a file too
 * big to hold as one string can only be hashed by streaming — the two have to
 * agree or a rename reads as a delete plus a new note.
 */
export function createContentHasher(): { update: (chunk: string) => void; digest: () => string } {
  // Simple djb2 hash - fast and sufficient for change detection
  let hash = 5381
  return {
    update(chunk: string): void {
      for (let i = 0; i < chunk.length; i++) {
        hash = (hash * 33) ^ chunk.charCodeAt(i)
      }
    },
    digest(): string {
      return (hash >>> 0).toString(16).padStart(8, '0')
    }
  }
}

export function generateContentHash(content: string): string {
  const hasher = createContentHasher()
  hasher.update(content)
  return hasher.digest()
}

// ============================================================================
// Properties Extraction (T007, T008)
// ============================================================================

import { PROJECT_PROPERTY_KEY, type PropertyType } from '@memry/contracts/property-types'

/**
 * Reserved frontmatter keys that are NOT properties — only the two keys with
 * Obsidian-defined semantics that Memry reads. Legacy Memry keys (id, title,
 * created, modified, emoji, localOnly) are plain user properties.
 */
const RESERVED_FRONTMATTER_KEYS = new Set(['tags', 'aliases'])

/**
 * Extract custom properties from frontmatter.
 * T007: Properties are stored under the `properties` key or as top-level keys
 * (excluding reserved keys like id, title, created, modified, tags, aliases).
 *
 * @param frontmatter - Parsed frontmatter object
 * @returns Record of property names to values
 */
export function extractProperties(frontmatter: NoteFrontmatter): Record<string, unknown> {
  // Check for explicit `properties` object first
  if (frontmatter.properties && typeof frontmatter.properties === 'object') {
    return frontmatter.properties as Record<string, unknown>
  }

  // Fall back to extracting non-reserved top-level keys
  const properties: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!RESERVED_FRONTMATTER_KEYS.has(key) && value !== undefined) {
      properties[key] = value
    }
  }

  return properties
}

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

/**
 * Serialize a property value for database storage.
 * Arrays and objects are JSON-encoded.
 *
 * @param value - Property value
 * @returns String representation for DB storage
 */
export function serializePropertyValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  // Arrays and objects get JSON-encoded
  return JSON.stringify(value)
}

/**
 * Deserialize a property value from database storage.
 *
 * @param value - Stored string value
 * @param type - Property type
 * @returns Parsed value
 */
export function deserializePropertyValue(value: string | null, type: PropertyType): unknown {
  if (value === null) {
    return null
  }

  switch (type) {
    case 'number':
      return Number(value)
    case 'checkbox':
      return value === 'true'
    case 'text':
    case 'date':
    case 'url':
    default:
      return value
  }
}

// ============================================================================
// Snippet Extraction
// ============================================================================

/**
 * Create a snippet from content for preview purposes.
 *
 * @param content - Markdown content
 * @param maxLength - Maximum snippet length (default 200)
 * @returns Truncated content with ellipsis if needed
 */
export function createSnippet(content: string, maxLength = 200): string {
  // Remove HTML comment markers (memry block-nesting/colors/file annotations).
  // Loop until stable: one pass can re-form `<!-- -->` from the text left on
  // either side of a removed comment.
  let cleaned = content
  let previousCleaned: string
  do {
    previousCleaned = cleaned
    cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '')
  } while (cleaned !== previousCleaned)

  // Remove markdown headers
  cleaned = cleaned.replace(/^#+\s+/gm, '')

  // Remove links but keep text
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  cleaned = cleaned.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '$2$1')

  // Remove images
  cleaned = cleaned.replace(/!\[[^\]]*\]\([^)]+\)/g, '')

  // Remove bold/italic markers
  cleaned = cleaned.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')

  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim()

  if (cleaned.length <= maxLength) {
    return cleaned
  }

  // Truncate at word boundary
  const truncated = cleaned.slice(0, maxLength)
  const lastSpace = truncated.lastIndexOf(' ')

  if (lastSpace > maxLength * 0.7) {
    return truncated.slice(0, lastSpace) + '...'
  }

  return truncated + '...'
}
