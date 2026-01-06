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
}

/**
 * Parsed journal entry from file.
 */
export interface ParsedJournalEntry {
  frontmatter: JournalFrontmatter
  content: string
  hadFrontmatter: boolean
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

  return {
    id: parsed.frontmatter.id,
    date: parsed.frontmatter.date,
    content: parsed.content,
    wordCount,
    characterCount,
    tags: parsed.frontmatter.tags ?? [],
    createdAt: parsed.frontmatter.created,
    modifiedAt: parsed.frontmatter.modified
  }
}

/**
 * Write a journal entry to the file system.
 * Creates the file if it doesn't exist, updates it if it does.
 *
 * @param date - Date in YYYY-MM-DD format
 * @param content - Markdown content (without frontmatter)
 * @param tags - Optional tags
 * @returns The created/updated journal entry
 */
export async function writeJournalEntry(
  date: string,
  content: string,
  tags?: string[]
): Promise<JournalEntry> {
  const filePath = getJournalPath(date)
  const journalDir = getJournalDir()

  // Ensure journal directory exists
  await ensureDirectory(journalDir)

  // Check if entry already exists
  const existing = await readJournalEntry(date)
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
  } else {
    // Create new entry
    frontmatter = createJournalFrontmatter(date, tags)
  }

  // Serialize and write
  const fileContent = serializeJournalEntry(frontmatter, content)
  await atomicWrite(filePath, fileContent)

  const wordCount = countWords(content)
  const characterCount = content.length

  return {
    id: frontmatter.id,
    date: frontmatter.date,
    content,
    wordCount,
    characterCount,
    tags: frontmatter.tags ?? [],
    createdAt: frontmatter.created,
    modifiedAt: frontmatter.modified
  }
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
