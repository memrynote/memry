/**
 * Convert a decoded Apple Notes document into Markdown.
 *
 * Ported in spirit from the Obsidian Apple Notes importer's NoteConverter, but
 * scoped to v1: text formatting (headings, bold/italic, strikethrough, lists,
 * checkboxes, monospace, blockquote, links) plus inline image attachments.
 *
 * Inline attachments are emitted as a placeholder token
 * `![](apple-notes-attachment:<identifier>)` and their identifiers collected;
 * the desktop importer resolves the bytes via SQLite, saves them, and rewrites
 * the token to the saved vault path. Tables, scans, drawings and handwriting
 * are deferred — they require the mergeable-data CRDT decode and on-disk
 * fallback files that are out of v1 scope.
 */

import { ANFontWeight, ANStyleType, AN_ATTACHMENT_UTI } from './types.ts'
import type { AttributeRun, ConvertedNote } from './types.ts'

/** Token the desktop importer rewrites once the attachment bytes are saved. */
export const ATTACHMENT_TOKEN_PREFIX = 'apple-notes-attachment:'

/** Inline text attachments that carry no file (hashtags, mentions, links). */
function isInlineTextAttachment(uti: string | undefined): boolean {
  return !!uti && uti.startsWith('com.apple.notes.inlinetextattachment')
}

/** Attachment UTIs deferred in v1 (tables / scans / drawings). */
const DEFERRED_UTIS = new Set<string>([
  AN_ATTACHMENT_UTI.Table,
  AN_ATTACHMENT_UTI.Scan,
  AN_ATTACHMENT_UTI.ModifiedScan,
  AN_ATTACHMENT_UTI.Drawing,
  AN_ATTACHMENT_UTI.DrawingLegacy,
  AN_ATTACHMENT_UTI.DrawingLegacy2
])

interface Segment {
  attr: AttributeRun
  text: string
}

/**
 * Split the flat note text into per-run segments. Apple Notes stores text as
 * one string plus runs that each cover `length` UTF-16 code units.
 */
function segmentRuns(decodedText: string, runs: AttributeRun[]): Segment[] {
  const segments: Segment[] = []
  let offset = 0
  for (const attr of runs) {
    const length = attr.length ?? 0
    const text = decodedText.slice(offset, offset + length)
    offset += length
    segments.push({ attr, text })
  }
  return segments
}

function applyInlineFormatting(attr: AttributeRun, text: string): string {
  // Don't decorate pure-whitespace fragments — markdown emphasis can't span them.
  if (!/\S/.test(text)) return text

  let out = text

  switch (attr.fontWeight) {
    case ANFontWeight.Bold:
      out = `**${out}**`
      break
    case ANFontWeight.Italic:
      out = `*${out}*`
      break
    case ANFontWeight.BoldItalic:
      out = `***${out}***`
      break
  }

  if (attr.strikethrough) out = `~~${out}~~`

  if (attr.link && attr.link !== text) {
    out = `[${out}](${attr.link})`
  }

  return out
}

function lineMarkdownPrefix(attr: AttributeRun, listCounter: { n: number }): string {
  const style = attr.paragraphStyle
  const styleType = (style?.styleType ?? ANStyleType.Default) as ANStyleType
  const indent = '\t'.repeat(Math.max(0, style?.indentAmount ?? 0))
  const quote = style?.blockquote ? '> ' : ''

  // Reset the ordered-list counter whenever we leave a numbered list.
  if (styleType !== ANStyleType.NumberedList) listCounter.n = 0

  switch (styleType) {
    case ANStyleType.Title:
      return `${quote}# `
    case ANStyleType.Heading:
      return `${quote}## `
    case ANStyleType.Subheading:
      return `${quote}### `
    case ANStyleType.DashedList:
    case ANStyleType.DottedList:
      return `${quote}${indent}- `
    case ANStyleType.NumberedList:
      listCounter.n += 1
      return `${quote}${indent}${listCounter.n}. `
    case ANStyleType.Checkbox: {
      const box = style?.checklist?.done ? '[x]' : '[ ]'
      return `${quote}${indent}- ${box} `
    }
    default:
      return quote
  }
}

/**
 * Convert a decoded note (text + runs) into markdown, collecting inline
 * attachment identifiers in encounter order.
 */
export function docToMarkdown(doc: { text: string; runs: AttributeRun[] }): ConvertedNote {
  const attachmentIds: string[] = []
  const segments = segmentRuns(doc.text, doc.runs)

  // Build markdown line by line so paragraph-level styles (headings, lists,
  // blockquotes) can be applied at the start of each line.
  const lines: string[] = []
  let current = ''
  let lineAttr: AttributeRun | null = null
  let monospace = false
  const listCounter = { n: 0 }

  const flushLine = (attr: AttributeRun | null) => {
    if (attr && !monospace) {
      const prefix = lineMarkdownPrefix(attr, listCounter)
      lines.push(prefix + current)
    } else {
      lines.push(current)
    }
    current = ''
    lineAttr = null
  }

  const setMonospace = (next: boolean) => {
    if (next === monospace) return
    if (next) {
      // Flush any pending inline text as a normal line first so it is not
      // swallowed into the opening code fence.
      if (current) flushLine(lineAttr)
      if (lines.length) lines.push('')
      lines.push('```')
    } else {
      // Drop the code paragraph's trailing newline so there is no blank line
      // before the closing fence.
      if (current) {
        current = current.replace(/\n$/, '')
        flushLine(lineAttr)
      }
      lines.push('```')
    }
    monospace = next
  }

  for (const seg of segments) {
    const attr = seg.attr
    const styleType = (attr.paragraphStyle?.styleType ?? ANStyleType.Default) as ANStyleType
    setMonospace(styleType === ANStyleType.Monospaced)

    // Inline attachment runs carry a single object-replacement char as text.
    if (attr.attachmentInfo) {
      const info = attr.attachmentInfo
      const uti = info.typeUti
      if (isInlineTextAttachment(uti)) {
        // Hashtags/mentions/internal links have no inline text we can recover
        // without a DB lookup — drop them quietly so text stays clean.
      } else if (uti && DEFERRED_UTIS.has(uti)) {
        current += ` *(unsupported attachment: ${uti})* `
      } else if (info.attachmentIdentifier) {
        attachmentIds.push(info.attachmentIdentifier)
        current += `![](${ATTACHMENT_TOKEN_PREFIX}${info.attachmentIdentifier})`
      }
      lineAttr = lineAttr ?? attr
      continue
    }

    if (monospace) {
      current += seg.text
      continue
    }

    // Emit the run text, splitting on newlines into separate markdown lines.
    // The paragraph style that decorates a line lives on whichever run carries
    // that line's content, so we track the attr of the run that ends the line.
    const parts = seg.text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part) current += applyInlineFormatting(attr, part)
      const isLineEnd = i < parts.length - 1
      if (isLineEnd) {
        flushLine(attr)
      } else if (part) {
        // Mid-line content (no trailing newline yet) — remember this run so a
        // later flush at the next segment's newline uses its paragraph style.
        lineAttr = attr
      }
    }
  }

  if (monospace) setMonospace(false)
  else if (current || lineAttr) flushLine(lineAttr)

  const markdown = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { markdown, attachmentIds }
}
