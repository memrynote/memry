/**
 * Phase 2 — convert a page's block outline into a nested markdown bullet list.
 *
 * Each block becomes one `- ` bullet, indented two spaces per depth level.
 * `heading` levels render the bullet text as a markdown heading (`#`..`######`).
 *
 * The per-block string is "scrubbed" from Roam markup conventions into Memry
 * markdown. Block references (`((uid))`, `{{embed: ((uid))}}`) are intentionally
 * left untouched here — phase 3 (`resolve-refs`) resolves them against the uid
 * index after conversion.
 */

import type { RoamBlock } from './types.ts'

const INDENT = '  '

/**
 * Convert Roam inline markup in a single block string to Memry markdown.
 *
 * Order matters: TODO/DONE checkboxes first (they own the line), then the
 * remaining inline transforms, then unknown `{{...}}` templates are dropped.
 * `((uid))` and the normalized `{{embed:((uid))}}` token are preserved for
 * phase 3.
 */
export function scrubMarkup(input: string): string {
  let out = input

  // {{[[TODO]]}} / {{TODO}} -> "[ ] " ; {{[[DONE]]}} / {{DONE}} -> "[x] "
  out = out.replace(/\{\{\[\[TODO\]\]\}\}\s*/g, '[ ] ').replace(/\{\{TODO\}\}\s*/g, '[ ] ')
  out = out.replace(/\{\{\[\[DONE\]\]\}\}\s*/g, '[x] ').replace(/\{\{DONE\}\}\s*/g, '[x] ')

  // __italic__ -> *italic*  (Roam uses double-underscore for italics)
  out = out.replace(/__(.+?)__/g, '*$1*')

  // ^^highlight^^ -> ==highlight==
  out = out.replace(/\^\^(.+?)\^\^/g, '==$1==')

  // Normalize embeds to a canonical `{{embed:((uid))}}` token (resolved in
  // phase 3). Both {{embed: ((uid))}} and {{[[embed]]: ((uid))}} are accepted.
  out = out.replace(
    /\{\{\[?\[?embed\]?\]?:\s*\(\(([^)]+)\)\)\s*\}\}/g,
    (_m, uid: string) => `{{embed:((${uid}))}}`
  )

  // Drop remaining unknown {{...}} templates (POMO, word-count, table, etc.),
  // but NOT the normalized embed token (negative lookahead on `embed:`).
  out = out.replace(/\{\{(?!embed:)[^}]*\}\}/g, '')

  return out
}

function headingPrefix(level: number | undefined): string {
  if (!level || level < 1) return ''
  const clamped = Math.min(level, 6)
  return '#'.repeat(clamped) + ' '
}

function convertBlock(block: RoamBlock, depth: number, lines: string[]): void {
  const indent = INDENT.repeat(depth)
  const scrubbed = scrubMarkup(block.string ?? '')
  const text = headingPrefix(block.heading) + scrubbed
  lines.push(`${indent}- ${text}`.replace(/\s+$/, ''))

  for (const child of block.children ?? []) {
    convertBlock(child, depth + 1, lines)
  }
}

/**
 * Convert a page's top-level blocks into a nested markdown bullet list.
 * Returns the markdown body (block refs still unresolved).
 */
export function convertBlocks(blocks: RoamBlock[]): string {
  const lines: string[] = []
  for (const block of blocks ?? []) {
    convertBlock(block, 0, lines)
  }
  return lines.join('\n')
}
