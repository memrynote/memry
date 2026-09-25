/**
 * The one-line preview a journal day shows in Month and on Home.
 *
 * Pure: no clock, no locale. Moved here from `apps/desktop/src/main/vault/journal.ts`
 * so the iOS core is held to the same rule by the `journal.json` vectors.
 *
 * @module journal/preview
 */

import { replaceWikiLinks } from '@memry/shared/wiki-target'

/** The preview length desktop asks for everywhere it shows one. */
export const JOURNAL_PREVIEW_LENGTH = 100

/**
 * Markdown to a short plain preview: headings, link targets, wiki-link
 * syntax, images and emphasis markers removed, whitespace collapsed, then
 * truncated at a word boundary when one falls in the last 30 % of the limit.
 *
 * Lengths are JavaScript string lengths (UTF-16 code units).
 */
export function extractJournalPreview(content: string, maxLength = JOURNAL_PREVIEW_LENGTH): string {
  // Remove markdown headers
  let cleaned = content.replace(/^#+\s+/gm, '')

  // Remove links but keep text
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  cleaned = replaceWikiLinks(cleaned)

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
