import { nanoid, customAlphabet } from 'nanoid'

/**
 * Generates a 21-character URL-safe unique ID.
 * Used for tasks, projects, and general entities.
 */
export const generateId = (): string => nanoid()

/**
 * Generates a 12-character lowercase alphanumeric ID.
 * Used for note frontmatter IDs (more readable in files).
 */
const noteIdAlphabet = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12)
export const generateNoteId = (): string => noteIdAlphabet()

/**
 * Generates a journal entry ID in the format: j{YYYY-MM-DD}
 * @param date - ISO date string (YYYY-MM-DD)
 */
export const generateJournalId = (date: string): string => `j${date}`

/**
 * Generates a shorter 8-character ID for internal references.
 */
const shortIdAlphabet = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8)
export const generateShortId = (): string => shortIdAlphabet()

/**
 * Validates that a string looks like a valid note ID.
 * Note IDs are 12 lowercase alphanumeric characters.
 */
export function isValidNoteId(id: string): boolean {
  return /^[0-9a-z]{12}$/.test(id)
}

/**
 * Validates that a string looks like a valid general ID.
 * General IDs are 21 URL-safe characters.
 */
export function isValidId(id: string): boolean {
  return /^[A-Za-z0-9_-]{21}$/.test(id)
}

/**
 * Validates that a string looks like a valid journal ID.
 * Journal IDs are in format: j{YYYY-MM-DD}
 */
export function isValidJournalId(id: string): boolean {
  return /^j\d{4}-\d{2}-\d{2}$/.test(id)
}
