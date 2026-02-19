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
import { getStatus, getConfig } from './index'
import { atomicWrite, safeRead, deleteFile, ensureDirectory, fileExists } from './file-ops'
import { VaultError, VaultErrorCode } from '../lib/errors'
import {
  generateJournalId,
  calculateActivityLevel,
  countWords,
  type JournalEntry,
  type ActivityLevel
} from '@shared/contracts/journal-api'

// ============================================================================
// Types
// ============================================================================

/**
 * Journal entry frontmatter fields.
 */
export interface JournalFrontmatter {
  id: string
  date: string
  created: string
  modified: string
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

/**
 * Generate the file path for a journal entry.
 * @param date - Date in YYYY-MM-DD format
 * @returns Absolute path to the journal file
 */
export function getJournalPath(date: string): string {
  const journalDir = getJournalDir()
  return path.join(journalDir, `${date}.md`)
}

/**
 * Convert absolute path to relative path (from vault root).
 */
function toRelativePath(absolutePath: string): string {
  const vaultPath = getVaultPath()
  return path.relative(vaultPath, absolutePath)
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
  const { data, content } = matter(rawContent)
  const hadFrontmatter = Object.keys(data).length > 0
  const now = new Date().toISOString()

  // Ensure required fields exist
  if (!data.id || typeof data.id !== 'string') {
    data.id = generateJournalId(date)
  }

  if (!data.date || typeof data.date !== 'string') {
    data.date = date
  }

  if (!data.created || typeof data.created !== 'string') {
    data.created = now
  }

  if (!data.modified || typeof data.modified !== 'string') {
    data.modified = now
  }

  // Normalize tags to array
  if (data.tags && !Array.isArray(data.tags)) {
    data.tags = [String(data.tags)]
  }

  return {
    frontmatter: data as JournalFrontmatter,
    content: content.trim(),
    hadFrontmatter
  }
}

/**
 * Serialize frontmatter and content to markdown format.
 * @param frontmatter - Frontmatter object
 * @param content - Markdown content (without frontmatter)
 * @returns Complete markdown file content with YAML frontmatter
 */
export function serializeJournalEntry(frontmatter: JournalFrontmatter, content: string): string {
  // Update modified timestamp
  const updatedFrontmatter = {
    ...frontmatter,
    modified: new Date().toISOString()
  }

  return matter.stringify(content.trim(), updatedFrontmatter)
}

/**
 * Create frontmatter for a new journal entry.
 * @param date - Date in YYYY-MM-DD format
 * @param tags - Optional tags
 * @returns Fresh frontmatter object
 */
export function createJournalFrontmatter(date: string, tags?: string[]): JournalFrontmatter {
  const now = new Date().toISOString()

  return {
    id: generateJournalId(date),
    date,
    created: now,
    modified: now,
    tags: tags ?? []
  }
}

// ============================================================================
// Properties Extraction
// ============================================================================

/**
 * Reserved frontmatter keys that are NOT custom properties.
 */
const RESERVED_JOURNAL_KEYS = new Set(['id', 'date', 'created', 'modified', 'tags', 'properties', 'emoji'])

/**
 * Extract custom properties from journal frontmatter.
 * Properties can be stored under the `properties` key or as top-level keys
 * (excluding reserved keys like id, date, created, modified, tags).
 *
 * @param frontmatter - Parsed frontmatter object
 * @returns Record of property names to values, or undefined if no properties
 */
export function extractJournalProperties(
  frontmatter: JournalFrontmatter
): Record<string, unknown> | undefined {
  // Check for explicit `properties` object first
  if (frontmatter.properties && typeof frontmatter.properties === 'object') {
    const props = frontmatter.properties as Record<string, unknown>
    return Object.keys(props).length > 0 ? props : undefined
  }

  // Fall back to extracting non-reserved top-level keys
  const properties: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!RESERVED_JOURNAL_KEYS.has(key) && value !== undefined) {
      properties[key] = value
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
  const filePath = getJournalPath(date)
  const rawContent = await safeRead(filePath)

  if (!rawContent) {
    return null
  }

  const parsed = parseJournalEntry(rawContent, date)
  const wordCount = countWords(parsed.content)
  const characterCount = parsed.content.length

  // Extract properties from frontmatter
  const properties = extractJournalProperties(parsed.frontmatter)

  return {
    id: parsed.frontmatter.id,
    date: parsed.frontmatter.date,
    content: parsed.content,
    wordCount,
    characterCount,
    tags: parsed.frontmatter.tags ?? [],
    createdAt: parsed.frontmatter.created,
    modifiedAt: parsed.frontmatter.modified,
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
  const filePath = getJournalPath(date)
  const journalDir = getJournalDir()

  // Ensure journal directory exists
  await ensureDirectory(journalDir)

  // Check if entry already exists
  const existing = existingEntry ?? (await readJournalEntry(date))
  let frontmatter: JournalFrontmatter

  if (existing) {
    // Update existing entry - preserve created timestamp
    frontmatter = {
      id: existing.id,
      date,
      created: existing.createdAt,
      modified: new Date().toISOString(),
      tags: tags ?? existing.tags
    }

    // Add properties if provided, or preserve existing properties
    if (properties !== undefined) {
      // Explicitly provided properties (can be empty object to clear)
      if (Object.keys(properties).length > 0) {
        frontmatter.properties = properties
      }
      // If properties is empty object, don't add to frontmatter (effectively clearing)
    } else if (existing.properties && Object.keys(existing.properties).length > 0) {
      // Preserve existing properties if not updating
      frontmatter.properties = existing.properties
    }
  } else {
    // Create new entry
    frontmatter = createJournalFrontmatter(date, tags)

    // Add properties for new entry if provided
    if (properties && Object.keys(properties).length > 0) {
      frontmatter.properties = properties
    }
  }

  // Serialize and write
  const fileContent = serializeJournalEntry(frontmatter, content)
  await atomicWrite(filePath, fileContent)

  const parsed = parseJournalEntry(fileContent, date)
  const wordCount = countWords(parsed.content)
  const characterCount = parsed.content.length

  // Extract properties from the written frontmatter
  const writtenProperties = extractJournalProperties(parsed.frontmatter)

  const entry: JournalEntry = {
    id: parsed.frontmatter.id,
    date: parsed.frontmatter.date,
    content: parsed.content,
    wordCount,
    characterCount,
    tags: parsed.frontmatter.tags ?? [],
    createdAt: parsed.frontmatter.created,
    modifiedAt: parsed.frontmatter.modified,
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
  const filePath = getJournalPath(date)

  if (!(await fileExists(filePath))) {
    return false
  }

  await deleteFile(filePath)
  return true
}

/**
 * Check if a journal entry exists.
 * @param date - Date in YYYY-MM-DD format
 * @returns True if entry exists
 */
export async function journalEntryExists(date: string): Promise<boolean> {
  const filePath = getJournalPath(date)
  return fileExists(filePath)
}

/**
 * Get the relative path for a journal entry.
 * @param date - Date in YYYY-MM-DD format
 * @returns Relative path from vault root
 */
export function getJournalRelativePath(date: string): string {
  const filePath = getJournalPath(date)
  return toRelativePath(filePath)
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
