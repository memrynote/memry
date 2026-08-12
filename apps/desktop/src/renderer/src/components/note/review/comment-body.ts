import type { MentionIconSpec } from '@/agent-chat/mention-icons'
import {
  CRITIC_MARKUP_COMMENT_FORMAT_MARKS,
  type CriticMarkupCommentFormatMark,
  type CriticMarkupCommentFormatRange,
  type CriticMarkupCommentMentionRef
} from '@memry/shared'

export type CommentBodyPart =
  | { kind: 'text'; text: string; start: number; end: number }
  | { kind: 'mention'; mention: CriticMarkupCommentMentionRef; start: number; end: number }

export type FormattedCommentBodyPart = CommentBodyPart & {
  marks: CriticMarkupCommentFormatMark[]
}

export function splitCommentBody(
  body: string,
  mentions: CriticMarkupCommentMentionRef[]
): CommentBodyPart[] {
  const parts: CommentBodyPart[] = []
  const used = new Set<string>()
  let cursor = 0

  while (cursor < body.length) {
    let next: {
      start: number
      end: number
      key: string
      mention: CriticMarkupCommentMentionRef
    } | null = null

    for (const mention of mentions) {
      const key = `${mention.kind}:${mention.refId}`
      if (used.has(key)) continue
      const token = `@${mention.label}`
      const start = body.indexOf(token, cursor)
      if (start === -1) continue
      if (!next || start < next.start) {
        next = { start, end: start + token.length, key, mention }
      }
    }

    if (!next) break
    if (next.start > cursor) {
      parts.push({
        kind: 'text',
        text: body.slice(cursor, next.start),
        start: cursor,
        end: next.start
      })
    }
    parts.push({ kind: 'mention', mention: next.mention, start: next.start, end: next.end })
    used.add(next.key)
    cursor = next.end
  }

  if (cursor < body.length) {
    parts.push({ kind: 'text', text: body.slice(cursor), start: cursor, end: body.length })
  }
  return parts
}

/**
 * Layers formatting on top of the mention segmentation, which runs first and
 * unchanged. Formatting can subdivide a text run but never a mention: the write
 * side emits `@label` as one unit, so a range can't begin inside one.
 */
export function splitCommentBodyWithFormat(
  body: string,
  mentions: CriticMarkupCommentMentionRef[],
  formatRanges: CriticMarkupCommentFormatRange[]
): FormattedCommentBodyPart[] {
  const parts = splitCommentBody(body, mentions)
  if (formatRanges.length === 0) return parts.map((part) => ({ ...part, marks: [] }))

  const marksAt = buildMarkLookup(body.length, formatRanges)
  return parts.flatMap((part): FormattedCommentBodyPart[] => {
    if (part.kind === 'mention') return [{ ...part, marks: marksAt(part.start) }]

    const runs: FormattedCommentBodyPart[] = []
    let runStart = part.start
    for (let offset = part.start; offset < part.end; offset++) {
      const isLast = offset === part.end - 1
      if (!isLast && sameMarks(marksAt(offset), marksAt(offset + 1))) continue
      runs.push({
        kind: 'text',
        text: body.slice(runStart, offset + 1),
        start: runStart,
        end: offset + 1,
        marks: marksAt(runStart)
      })
      runStart = offset + 1
    }
    return runs
  })
}

/**
 * Trims the composer text the way the storage layer will, shifting the ranges
 * with it. Trimming must happen exactly once, or the offsets drift.
 */
export function trimCommentBodyWithFormat(
  text: string,
  formatRanges: CriticMarkupCommentFormatRange[]
): { body: string; formatRanges: CriticMarkupCommentFormatRange[] } {
  const body = text.trim()
  if (!body) return { body, formatRanges: [] }

  const offset = text.indexOf(body)
  const shifted = formatRanges.flatMap((range) => {
    const start = Math.max(0, range.start - offset)
    const end = Math.min(body.length, range.end - offset)
    if (end <= start) return []
    return [{ start, end, marks: range.marks }]
  })
  return { body, formatRanges: shifted }
}

// Char-level rather than range-intersection so overlapping or hand-edited
// ranges degrade to a union instead of producing tangled output.
function buildMarkLookup(
  bodyLength: number,
  formatRanges: CriticMarkupCommentFormatRange[]
): (offset: number) => CriticMarkupCommentFormatMark[] {
  const table: Set<CriticMarkupCommentFormatMark>[] = Array.from(
    { length: bodyLength },
    () => new Set()
  )
  for (const range of formatRanges) {
    for (
      let offset = Math.max(0, range.start);
      offset < Math.min(bodyLength, range.end);
      offset++
    ) {
      for (const mark of range.marks) table[offset].add(mark)
    }
  }
  const resolved = table.map((marks) =>
    CRITIC_MARKUP_COMMENT_FORMAT_MARKS.filter((mark) => marks.has(mark))
  )
  return (offset) => resolved[offset] ?? []
}

function sameMarks(
  first: CriticMarkupCommentFormatMark[],
  second: CriticMarkupCommentFormatMark[]
): boolean {
  return first.length === second.length && first.every((mark, index) => mark === second[index])
}

export function iconForMention(mention: CriticMarkupCommentMentionRef): MentionIconSpec {
  switch (mention.kind) {
    case 'note':
      return { kind: 'note', emoji: null }
    case 'task':
      return { kind: 'task' }
    case 'journal':
      return { kind: 'journal' }
    case 'inbox':
      return { kind: 'inbox', itemType: null }
    case 'calendar_event':
      return { kind: 'calendar_event' }
  }
}
