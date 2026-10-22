/**
 * The plain text of a note's opening, for a surface that shows what the editor
 * shows (a wiki-link card, #2845).
 *
 * `createSnippet` and `extractJournalPreview` only strip inline marks. A card
 * put a column layout's `--- start-multi-column` lines, its fenced
 * `column-settings`, `<details>` tags and table pipes in front of the reader,
 * none of which the editor draws. This reads the file block by block instead.
 */

import { replaceWikiLinks } from './wiki-target'

const FENCE = /^\s*(```|~~~)/
const THEMATIC_BREAK = /^\s*([-*_])(\s*\1){2,}\s*$/
const COLUMN_MARKER = /^\s*---\s*(start-multi-column|end-column|end-multi-column)\b/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function dropFrontmatter(lines: string[]): string[] {
  if (lines[0]?.trim() !== '---') return lines
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  return end === -1 ? lines : lines.slice(end + 1)
}

function inlineText(line: string): string {
  const text = line
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/%%[\s\S]*?%%/g, '')
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
  return replaceWikiLinks(text)
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/[*_]([^*_]+)[*_]/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
}

/** A table row starts with a pipe; a pipe elsewhere (`[[a|b]]`) belongs to the text. */
function tableRowText(line: string): string {
  if (!/^\s*\|/.test(line)) return line
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .replace(/\s*\|\s*/g, ' ')
}

function blockText(line: string): string {
  return tableRowText(line)
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^(\s*>\s?)+/, '')
    .replace(/^\s*\[!\w[\w-]*\][+-]?\s*/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
}

/** The opening of `markdown` as one line of plain text, or null when it has none. */
export function markdownPreviewText(markdown: string, maxLength = 240): string | null {
  const kept: string[] = []
  let inFence = false

  for (const line of dropFrontmatter(markdown.split(/\r?\n/))) {
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || COLUMN_MARKER.test(line) || THEMATIC_BREAK.test(line) || TABLE_RULE.test(line)) {
      continue
    }
    const text = inlineText(blockText(line)).replace(/\s+/g, ' ').trim()
    if (text) kept.push(text)
  }

  const joined = kept.join(' ')
  if (!joined) return null
  if (joined.length <= maxLength) return joined

  const cut = joined.slice(0, maxLength)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > maxLength * 0.7 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}
