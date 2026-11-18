import {
  normalizeCriticMarkupCommentAttachments,
  normalizeCriticMarkupCommentFormatRanges,
  normalizeCriticMarkupCommentMentions,
  type CriticMarkupKind,
  type CriticMarkupMark
} from './parser'
import { isObject } from '../is-record'

export const CRITIC_MARKUP_MARKS_ARRAY = 'criticMarkupMarks'

interface YArrayLike {
  length: number
  get(index: number): unknown
  toArray?: () => unknown[]
  delete(index: number, length: number): void
  push(values: unknown[]): void
}

interface YDocLike {
  getArray(name: string): YArrayLike
}

const VALID_KINDS: ReadonlySet<unknown> = new Set<CriticMarkupKind>([
  'addition',
  'deletion',
  'substitution',
  'comment'
])

function isCriticMarkupKind(value: unknown): value is CriticMarkupKind {
  return VALID_KINDS.has(value)
}

/**
 * Each mark once, by id: two devices that rewrote the array concurrently leave both pushes in the
 * merged doc. The first copy wins.
 */
export function readCriticMarkupMarksFromYDoc(doc: YDocLike): CriticMarkupMark[] {
  const array = doc.getArray(CRITIC_MARKUP_MARKS_ARRAY)
  const values = array.toArray ? array.toArray() : readArrayLike(array)
  const seen = new Set<string>()
  return values.flatMap((value) => {
    const mark = normalizeCriticMarkupMark(value)
    if (!mark || seen.has(mark.id)) return []
    seen.add(mark.id)
    return [mark]
  })
}

/**
 * Rewrites the array. A field this build does not know, which a newer build wrote on a mark, is
 * carried over from the mark of the same id in the doc: devices on different versions share it.
 */
export function writeCriticMarkupMarksToYDoc(doc: YDocLike, marks: CriticMarkupMark[]): void {
  const array = doc.getArray(CRITIC_MARKUP_MARKS_ARRAY)
  const current = array.toArray ? array.toArray() : readArrayLike(array)
  const unknownFieldsById = new Map<string, Record<string, unknown>>()
  for (const value of current) {
    if (!isObject(value) || typeof value.id !== 'string' || unknownFieldsById.has(value.id))
      continue
    unknownFieldsById.set(
      value.id,
      Object.fromEntries(Object.entries(value).filter(([key]) => !KNOWN_FIELDS.has(key)))
    )
  }
  const next = marks.flatMap((mark) => {
    const normalized = normalizeCriticMarkupMark(mark)
    if (!normalized) return []
    return [{ ...toSerializableMark(normalized), ...unknownFieldsById.get(normalized.id) }]
  })
  if (JSON.stringify(current) === JSON.stringify(next)) return

  if (array.length > 0) array.delete(0, array.length)
  if (next.length > 0) array.push(next)
}

function readArrayLike(array: YArrayLike): unknown[] {
  const values: unknown[] = []
  for (let index = 0; index < array.length; index++) {
    values.push(array.get(index))
  }
  return values
}

function normalizeCriticMarkupMark(value: unknown): CriticMarkupMark | null {
  if (!isObject(value)) return null
  const mark = value
  if (typeof mark.id !== 'string') return null
  if (!isCriticMarkupKind(mark.kind)) return null
  if (typeof mark.visibleText !== 'string') return null
  if (typeof mark.start !== 'number' || typeof mark.end !== 'number') return null
  if (!Number.isFinite(mark.start) || !Number.isFinite(mark.end)) return null
  if (mark.start < 0 || mark.end < mark.start) return null

  const mentions = normalizeCriticMarkupCommentMentions(mark.mentions)
  const attachments = normalizeCriticMarkupCommentAttachments(mark.attachments)
  const formatRanges = normalizeCriticMarkupCommentFormatRanges(
    mark.formatRanges,
    (typeof mark.body === 'string' ? mark.body : '').trim().length
  )

  return {
    id: mark.id,
    kind: mark.kind,
    visibleText: mark.visibleText,
    start: mark.start,
    end: mark.end,
    ...(typeof mark.originalText === 'string' ? { originalText: mark.originalText } : {}),
    ...(typeof mark.body === 'string' ? { body: mark.body } : {}),
    ...(typeof mark.metadata === 'string' ? { metadata: mark.metadata } : {}),
    ...(typeof mark.createdAt === 'number' && Number.isFinite(mark.createdAt)
      ? { createdAt: mark.createdAt }
      : {}),
    ...(mentions ? { mentions } : {}),
    ...(attachments ? { attachments } : {}),
    ...(formatRanges ? { formatRanges } : {})
  }
}

// Every field of a mark: a record, so a field added to the type must be listed here.
const KNOWN_FIELD_RECORD: Record<keyof CriticMarkupMark, true> = {
  id: true,
  kind: true,
  visibleText: true,
  start: true,
  end: true,
  originalText: true,
  body: true,
  metadata: true,
  createdAt: true,
  mentions: true,
  attachments: true,
  formatRanges: true
}
const KNOWN_FIELDS: ReadonlySet<string> = new Set(Object.keys(KNOWN_FIELD_RECORD))

function toSerializableMark(mark: CriticMarkupMark): Record<string, unknown> {
  return {
    id: mark.id,
    kind: mark.kind,
    visibleText: mark.visibleText,
    start: mark.start,
    end: mark.end,
    ...(mark.originalText !== undefined ? { originalText: mark.originalText } : {}),
    ...(mark.body !== undefined ? { body: mark.body } : {}),
    ...(mark.metadata !== undefined ? { metadata: mark.metadata } : {}),
    ...(mark.createdAt !== undefined ? { createdAt: mark.createdAt } : {}),
    ...(mark.mentions !== undefined ? { mentions: mark.mentions } : {}),
    ...(mark.attachments !== undefined ? { attachments: mark.attachments } : {}),
    ...(mark.formatRanges !== undefined ? { formatRanges: mark.formatRanges } : {})
  }
}
