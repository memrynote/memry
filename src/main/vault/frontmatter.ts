/**
 * Frontmatter parsing and serialization for markdown notes.
 * Uses gray-matter for YAML frontmatter handling.
 *
 * @module vault/frontmatter
 */

import matter from 'gray-matter'
import path from 'path'
import { generateNoteId, isValidNoteId } from '../lib/id'

// ============================================================================
// Types
// ============================================================================

/**
 * Frontmatter fields stored in note YAML header.
 */
export interface NoteFrontmatter {
  id: string
  title?: string
  created: string
  modified: string
  tags?: string[]
  aliases?: string[]
  [key: string]: unknown // Allow custom properties
}

/**
 * Result of parsing a markdown file with frontmatter.
 */
export interface ParsedNote {
  frontmatter: NoteFrontmatter
  content: string
  /** Whether frontmatter was present in the original file */
  hadFrontmatter: boolean
  /** Whether any required fields were missing and auto-generated */
  wasModified: boolean
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a markdown file content into frontmatter and body.
 * Missing required fields (id, created, modified) are auto-generated.
 *
 * @param rawContent - Raw file content including frontmatter
 * @param filePath - Optional file path for extracting title from filename
 * @returns Parsed note with frontmatter and content
 */
export function parseNote(rawContent: string, filePath?: string): ParsedNote {
  const { data, content } = matter(rawContent)
  const hadFrontmatter = Object.keys(data).length > 0
  const now = new Date().toISOString()
  let wasModified = false

  // Ensure required fields exist
  if (!data.id || typeof data.id !== 'string') {
    data.id = generateNoteId()
    wasModified = true
  }

  if (!data.created || typeof data.created !== 'string') {
    data.created = now
    wasModified = true
  }

  if (!data.modified || typeof data.modified !== 'string') {
    data.modified = now
    wasModified = true
  }

  // Extract title from filename if not in frontmatter
  if (!data.title && filePath) {
    data.title = extractTitleFromPath(filePath)
  }

  // Normalize tags to array
  if (data.tags && !Array.isArray(data.tags)) {
    data.tags = [String(data.tags)]
    wasModified = true
  }

  // Normalize aliases to array
  if (data.aliases && !Array.isArray(data.aliases)) {
    data.aliases = [String(data.aliases)]
    wasModified = true
  }

  return {
    frontmatter: data as NoteFrontmatter,
    content: content.trim(),
    hadFrontmatter,
    wasModified
  }
}

/**
 * Extract a display title from a file path.
 * Removes extension and converts dashes/underscores to spaces.
 *
 * @param filePath - File path (can be relative or absolute)
 * @returns Human-readable title
 */
export function extractTitleFromPath(filePath: string): string {
  const basename = path.basename(filePath, '.md')
  // Convert kebab-case and snake_case to Title Case
  return basename
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

// ============================================================================
// Serialization
// ============================================================================

function stripTrailingNewlines(value: string): string {
  return value.replace(/(?:\r?\n)+$/g, '')
}

/**
 * Serialize frontmatter and content back to markdown format.
 *
 * @param frontmatter - Frontmatter object
 * @param content - Markdown content (without frontmatter)
 * @returns Complete markdown file content with YAML frontmatter
 */
export function serializeNote(frontmatter: NoteFrontmatter, content: string): string {
  // Update modified timestamp
  const updatedFrontmatter = {
    ...frontmatter,
    modified: new Date().toISOString()
  }

  const serialized = matter.stringify(content.trim(), updatedFrontmatter)
  return stripTrailingNewlines(serialized)
}

/**
 * Create frontmatter for a new note.
 *
 * @param title - Note title
 * @param tags - Optional tags
 * @returns Fresh frontmatter object
 */
export function createFrontmatter(title: string, tags?: string[]): NoteFrontmatter {
  const now = new Date().toISOString()

  return {
    id: generateNoteId(),
    title,
    created: now,
    modified: now,
    tags: tags ?? []
  }
}

// ============================================================================
// Validation & Utilities
// ============================================================================

/**
 * Ensure a markdown file has valid frontmatter.
 * If frontmatter is missing or incomplete, it will be added/completed.
 *
 * @param rawContent - Raw file content
 * @param filePath - File path for title extraction
 * @returns Updated file content with complete frontmatter
 */
export function ensureFrontmatter(rawContent: string, filePath: string): string {
  const parsed = parseNote(rawContent, filePath)

  if (!parsed.hadFrontmatter || parsed.wasModified) {
    // Re-serialize with complete frontmatter
    const serialized = matter.stringify(parsed.content, parsed.frontmatter)
    return stripTrailingNewlines(serialized)
  }

  // No changes needed
  return rawContent
}

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
 * @param content - Markdown content
 * @returns Array of link targets
 */
export function extractWikiLinks(content: string): string[] {
  const linkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
  const links = new Set<string>()
  let match

  while ((match = linkPattern.exec(content)) !== null) {
    links.add(match[1].trim())
  }

  return Array.from(links)
}

/**
 * Extract all tags from frontmatter, normalizing to lowercase.
 *
 * @param frontmatter - Parsed frontmatter
 * @returns Array of normalized tag strings
 */
export function extractTags(frontmatter: NoteFrontmatter): string[] {
  if (!frontmatter.tags || !Array.isArray(frontmatter.tags)) {
    return []
  }

  return frontmatter.tags
    .map((tag) => String(tag).toLowerCase().trim())
    .filter((tag) => tag.length > 0)
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
  const words = withoutInlineCode
    .split(/\s+/)
    .filter((word) => word.length > 0)

  return words.length
}

/**
 * Generate a content hash for change detection.
 * Uses a simple hash of the full file content.
 *
 * @param content - Full file content including frontmatter
 * @returns Hash string
 */
export function generateContentHash(content: string): string {
  // Simple djb2 hash - fast and sufficient for change detection
  let hash = 5381
  for (let i = 0; i < content.length; i++) {
    hash = (hash * 33) ^ content.charCodeAt(i)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// ============================================================================
// Properties Extraction (T007, T008)
// ============================================================================

import type { PropertyType } from '@shared/db/schema/notes-cache'

/**
 * Reserved frontmatter keys that are NOT properties.
 */
const RESERVED_FRONTMATTER_KEYS = new Set([
  'id',
  'title',
  'created',
  'modified',
  'tags',
  'aliases'
])

/**
 * Extract custom properties from frontmatter.
 * T007: Properties are stored under the `properties` key or as top-level keys
 * (excluding reserved keys like id, title, created, modified, tags, aliases).
 *
 * @param frontmatter - Parsed frontmatter object
 * @returns Record of property names to values
 */
export function extractProperties(
  frontmatter: NoteFrontmatter
): Record<string, unknown> {
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
 * @param name - Property name (used for contextual hints like "rating")
 * @param value - Property value to infer type from
 * @returns Inferred property type
 */
export function inferPropertyType(name: string, value: unknown): PropertyType {
  // Boolean -> checkbox
  if (typeof value === 'boolean') {
    return 'checkbox'
  }

  // Number with contextual hints
  if (typeof value === 'number') {
    // Check if this looks like a rating (1-5 range and name contains "rating")
    if (value >= 1 && value <= 5 && name.toLowerCase().includes('rating')) {
      return 'rating'
    }
    return 'number'
  }

  // Array -> multiselect
  if (Array.isArray(value)) {
    return 'multiselect'
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
export function deserializePropertyValue(
  value: string | null,
  type: PropertyType
): unknown {
  if (value === null) {
    return null
  }

  switch (type) {
    case 'number':
    case 'rating':
      return Number(value)
    case 'checkbox':
      return value === 'true'
    case 'multiselect':
      try {
        return JSON.parse(value)
      } catch {
        return []
      }
    case 'text':
    case 'date':
    case 'url':
    case 'select':
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
  // Remove markdown headers
  let cleaned = content.replace(/^#+\s+/gm, '')

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
