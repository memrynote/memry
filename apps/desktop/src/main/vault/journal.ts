/**
 * Journal file operations.
 * Handles reading, writing, and deleting journal entry markdown files.
 *
 * Journal entries are stored as markdown files with YAML frontmatter in:
 * vault/journal/YYYY-MM-DD.md
 *
 * @module vault/journal
 */

import path from 'path'
import matter from 'gray-matter'
import { createNoteContentStore } from '@memry/storage-vault'
import { applyPropertiesToFrontmatter } from './frontmatter'
import { emitFrontmatterBlock, OBSIDIAN_MATTER_OPTIONS } from './frontmatter-emit'
import { getStatus, getConfig } from './index'
import { ensureDirectory } from './file-ops'
import { VaultError, VaultErrorCode } from '../lib/errors'
import {
  generateJournalId,
  calculateActivityLevel,
  countWords,
  type JournalEntry,
  type ActivityLevel
} from '@memry/contracts/journal-api'

// ============================================================================
// Types
// ============================================================================

/**
 * Journal entry frontmatter fields. Every key is a plain user property;
 * Memry writes only `date` (and `tags`/`properties` on explicit edit).
 * Legacy Memry keys (id, created, modified) are plain user properties.
 */
export interface JournalFrontmatter {
  date?: string
  tags?: string[]
  [key: string]: unknown
}

/**
 * Parsed journal entry from file.
 */
export interface ParsedJournalEntry {
  frontmatter: JournalFrontmatter
  content: string
  hadFrontmatter: boolean
  /** In-memory defaults — never written back to the file */
  id: string
  date: string
  created: string
  modified: string
}

/**
 * Result of writing a journal entry, including the serialized file content.
 */
export interface JournalWriteResult {
  entry: JournalEntry
  fileContent: string
  frontmatter: JournalFrontmatter
}

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Get the vault path, throwing if no vault is open.
 */
function getVaultPath(): string {
  const status = getStatus()
  if (!status.path) {
    throw new VaultError('No vault is currently open', VaultErrorCode.NOT_INITIALIZED)
  }
  return status.path
}

/**
 * Get the journal directory path.
 */
function getJournalDir(): string {
  const vaultPath = getVaultPath()
  const config = getConfig()
  return path.join(vaultPath, config.journalFolder)
}

function getContentStore() {
  const vaultPath = getVaultPath()
  const config = getConfig()
  return createNoteContentStore({
    rootPath: vaultPath,
    notesFolder: config.defaultNoteFolder,
    journalFolder: config.journalFolder,
    journalDateFormat: config.journalDateFormat
  })
}

/**
 * Generate the file path for a journal entry.
 * @param date - Date in YYYY-MM-DD format
 * @returns Absolute path to the journal file
 */
export function getJournalPath(date: string): string {
  const store = getContentStore()
  return store.resolve(store.getJournalRelativePath(date))
}

// ============================================================================
// Frontmatter Parsing & Serialization
// ============================================================================

/**
 * Parse a journal markdown file into frontmatter and content.
 * @param rawContent - Raw file content including frontmatter
 * @param date - Date in YYYY-MM-DD format (for generating missing fields)
 * @returns Parsed journal entry
 */
export function parseJournalEntry(rawContent: string, date: string): ParsedJournalEntry {
  const { data, content } = matter(rawContent, OBSIDIAN_MATTER_OPTIONS)
  const hadFrontmatter = Object.keys(data).length > 0
  const now = new Date().toISOString()

  // Normalize tags to array (read-side only, never written back)
  if (data.tags && !Array.isArray(data.tags)) {
    data.tags = [String(data.tags)]
  }

  return {
    frontmatter: data as JournalFrontmatter,
    content: content.trim(),
    hadFrontmatter,
    id: generateJournalId(date),
    date,
    created: now,
    modified: now
  }
}

/**
 * Serialize frontmatter and content to markdown format.
 * Writes exactly the keys given; no keys → bare content, no YAML block.
 *
 * @param frontmatter - Frontmatter object
 * @param content - Markdown content (without frontmatter)
 * @returns Complete markdown file content
 */
export function serializeJournalEntry(frontmatter: JournalFrontmatter, content: string): string {
  const entries = Object.entries(frontmatter).filter(([, v]) => v !== undefined)

  if (entries.length === 0) {
    return content.trim()
  }

  const body = content.trim()
  return body ? `${emitFrontmatterBlock(entries)}${body}\n` : emitFrontmatterBlock(entries)
}

/**
 * Create frontmatter for a new journal entry — user keys only.
 * @param date - Date in YYYY-MM-DD format
 * @param tags - Optional tags
 * @returns Fresh frontmatter object
 */
export function createJournalFrontmatter(date: string, tags?: string[]): JournalFrontmatter {
  return {
    date,
    ...(tags && tags.length > 0 ? { tags } : {})
  }
}

// ============================================================================
// Properties Extraction
// ============================================================================

/**
 * Reserved frontmatter keys that are NOT custom properties. `date` stays
 * reserved: Memry writes it itself on every journal save. Legacy Memry keys
 * (id, created, modified, emoji) found in files are plain user properties.
 */
const RESERVED_JOURNAL_KEYS = new Set(['date', 'tags'])

/**
 * Extract custom properties from journal frontmatter.
 * Top-level non-reserved keys are primary; a legacy nested `properties:`
 * mapping is merged in after them (top-level wins on collision).
 *
 * @param frontmatter - Parsed frontmatter object
 * @returns Record of property names to values, or undefined if no properties
 */
export function extractJournalProperties(
  frontmatter: JournalFrontmatter
): Record<string, unknown> | undefined {
  const nested =
    frontmatter.properties &&
    typeof frontmatter.properties === 'object' &&
    !Array.isArray(frontmatter.properties)
      ? (frontmatter.properties as Record<string, unknown>)
      : undefined

  const properties: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === 'properties' && nested) continue
    if (!RESERVED_JOURNAL_KEYS.has(key) && value !== undefined) {
      properties[key] = value
    }
  }

  if (nested) {
    for (const [key, value] of Object.entries(nested)) {
      if (!(key in properties) && !RESERVED_JOURNAL_KEYS.has(key) && value !== undefined) {
        properties[key] = value
      }
    }
  }

  return Object.keys(properties).length > 0 ? properties : undefined
}

// ============================================================================
// File Operations
// ============================================================================

/**
 * Read a journal entry from the file system.
 * @param date - Date in YYYY-MM-DD format
 * @returns Journal entry or null if not found
 */
export async function readJournalEntry(date: string): Promise<JournalEntry | null> {
  const store = getContentStore()
  const rawContent = await store.read(store.getJournalRelativePath(date))

  if (!rawContent) {
    return null
  }

  const parsed = parseJournalEntry(rawContent, date)
  const wordCount = countWords(parsed.content)
  const characterCount = parsed.content.length

  // Extract properties from frontmatter
  const properties = extractJournalProperties(parsed.frontmatter)

  return {
    id: parsed.id,
    date: parsed.date,
    content: parsed.content,
    wordCount,
    characterCount,
    tags: parsed.frontmatter.tags ?? [],
    createdAt: parsed.created,
    modifiedAt: parsed.modified,
    properties
  }
}

/**
 * Write a journal entry to the file system.
 * Creates the file if it doesn't exist, updates it if it does.
 *
 * @param date - Date in YYYY-MM-DD format
 * @param content - Markdown content (without frontmatter)
 * @param tags - Optional tags
 * @param existingEntry - Optional existing entry data (to avoid re-reading)
 * @param properties - Optional custom properties to store in frontmatter
 * @returns The created/updated journal entry and serialized file content
 */
export async function writeJournalEntryWithContent(
  date: string,
  content: string,
  tags?: string[],
  existingEntry?: JournalEntry | null,
  properties?: Record<string, unknown>
): Promise<JournalWriteResult> {
  const journalDir = getJournalDir()
  const store = getContentStore()
  const relativePath = store.getJournalRelativePath(date)

  // Ensure journal directory exists
  await ensureDirectory(journalDir)

  // Check if entry already exists
  const existing = existingEntry ?? (await readJournalEntry(date))
  let frontmatter: JournalFrontmatter

  if (existing) {
    // Update existing entry — user keys only, properties as top-level keys
    frontmatter = { date }
    const mergedTags = tags ?? existing.tags
    if (mergedTags.length > 0) {
      frontmatter.tags = mergedTags
    }

    // Explicitly provided properties win (empty object clears); else preserve
    const nextProperties = properties !== undefined ? properties : (existing.properties ?? {})
    frontmatter = applyPropertiesToFrontmatter(
      frontmatter,
      nextProperties,
      RESERVED_JOURNAL_KEYS
    ) as JournalFrontmatter
  } else {
    // Create new entry
    frontmatter = createJournalFrontmatter(date, tags)

    if (properties && Object.keys(properties).length > 0) {
      frontmatter = applyPropertiesToFrontmatter(
        frontmatter,
        properties,
        RESERVED_JOURNAL_KEYS
      ) as JournalFrontmatter
    }
  }

  // Serialize and write
  const fileContent = serializeJournalEntry(frontmatter, content)
  await store.write(relativePath, fileContent)

  const parsed = parseJournalEntry(fileContent, date)
  const wordCount = countWords(parsed.content)
  const characterCount = parsed.content.length

  // Extract properties from the written frontmatter
  const writtenProperties = extractJournalProperties(parsed.frontmatter)

  const entry: JournalEntry = {
    id: parsed.id,
    date: parsed.date,
    content: parsed.content,
    wordCount,
    characterCount,
    tags: parsed.frontmatter.tags ?? [],
    createdAt: existing?.createdAt ?? parsed.created,
    modifiedAt: parsed.modified,
    properties: writtenProperties
  }

  return {
    entry,
    fileContent,
    frontmatter: parsed.frontmatter
  }
}

/**
 * Write a journal entry to the file system.
 * Creates the file if it doesn't exist, updates it if it does.
 *
 * @param date - Date in YYYY-MM-DD format
 * @param content - Markdown content (without frontmatter)
 * @param tags - Optional tags
 * @param properties - Optional custom properties
 * @returns The created/updated journal entry
 */
export async function writeJournalEntry(
  date: string,
  content: string,
  tags?: string[],
  properties?: Record<string, unknown>
): Promise<JournalEntry> {
  const result = await writeJournalEntryWithContent(date, content, tags, null, properties)
  return result.entry
}

/**
 * Delete a journal entry file.
 * @param date - Date in YYYY-MM-DD format
 * @returns True if file was deleted, false if it didn't exist
 */
export async function deleteJournalEntryFile(date: string): Promise<boolean> {
  const store = getContentStore()
  return store.remove(store.getJournalRelativePath(date))
}

/**
 * Check if a journal entry exists.
 * @param date - Date in YYYY-MM-DD format
 * @returns True if entry exists
 */
export async function journalEntryExists(date: string): Promise<boolean> {
  const store = getContentStore()
  return store.exists(store.getJournalRelativePath(date))
}

/**
 * Get the relative path for a journal entry.
 * @param date - Date in YYYY-MM-DD format
 * @returns Relative path from vault root
 */
export function getJournalRelativePath(date: string): string {
  return getContentStore().getJournalRelativePath(date)
}

// ============================================================================
// Cache Data Helpers
// ============================================================================

/**
 * Calculate activity level from content.
 * Used when creating/updating cache entries.
 * @param content - Markdown content
 * @returns Activity level (0-4)
 */
export function calculateActivityLevelFromContent(content: string): ActivityLevel {
  return calculateActivityLevel(content.length)
}

/**
 * Extract preview text from content.
 * @param content - Markdown content
 * @param maxLength - Maximum preview length
 * @returns Preview string
 */
export function extractPreview(content: string, maxLength = 100): string {
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
