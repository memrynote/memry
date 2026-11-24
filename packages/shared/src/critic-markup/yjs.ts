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
  insert(index: number, values: unknown[]): void
  push(values: unknown[]): void
}

interface YDocLike {
  getArray(name: string): YArrayLike
  transact?: (fn: () => void) => void
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
 * The doc's marks, one per id. Two devices that change the same mark at once
 * each replace its element, and the array keeps both; the first one in array
 * order is the mark, on every device, and the next write removes the other.
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

/** Makes the doc's marks exactly `marks`. */
export function writeCriticMarkupMarksToYDoc(doc: YDocLike, marks: CriticMarkupMark[]): void {
  const ids = new Set(marks.map((mark) => mark.id))
  updateMarks(doc, marks, (id) => !ids.has(id))
}

/** Adds or replaces the `upsert` marks and removes the `remove` ids; leaves every other mark. */
export function updateCriticMarkupMarksInYDoc(
  doc: YDocLike,
  { upsert = [], remove = [] }: { upsert?: CriticMarkupMark[]; remove?: string[] }
): void {
  const removed = new Set(remove)
  updateMarks(doc, upsert, (id) => removed.has(id))
}

/**
 * One transaction of element edits, never a rewrite of the array: an element
 * whose mark does not change is not touched, so a concurrent edit to another
 * mark merges instead of being replaced by this writer's copy of it. A changed
 * mark is replaced where it stands, keeping fields this build does not know.
 * Elements the reader drops are left alone, so a newer build's marks survive.
 */
function updateMarks(
  doc: YDocLike,
  upsert: CriticMarkupMark[],
  isRemoved: (id: string) => boolean
): void {
  const array = doc.getArray(CRITIC_MARKUP_MARKS_ARRAY)
  const pending = new Map<string, Record<string, unknown>>()
  for (const mark of upsert) {
    const normalized = normalizeCriticMarkupMark(mark)
    if (normalized && !pending.has(normalized.id)) {
      pending.set(normalized.id, toSerializableMark(normalized))
    }
  }
  const values = array.toArray ? array.toArray() : readArrayLike(array)
  const marks = values.map((value) => normalizeCriticMarkupMark(value))
  const firstIndex = new Map<string, number>()
  marks.forEach((mark, index) => {
    if (mark && !firstIndex.has(mark.id)) firstIndex.set(mark.id, index)
  })

  const apply = (): void => {
    for (let index = values.length - 1; index >= 0; index--) {
      const mark = marks[index]
      if (!mark) continue
      if (firstIndex.get(mark.id) !== index || isRemoved(mark.id)) {
        array.delete(index, 1)
        continue
      }
      const next = pending.get(mark.id)
      if (!next) continue
      pending.delete(mark.id)
      if (JSON.stringify(toSerializableMark(mark)) === JSON.stringify(next)) continue
      array.delete(index, 1)
      array.insert(index, [{ ...unknownFields(values[index]), ...next }])
    }
    if (pending.size > 0) array.push([...pending.values()])
  }
  if (doc.transact) doc.transact(apply)
  else apply()
}

const KNOWN_MARK_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'kind',
  'visibleText',
  'start',
  'end',
  'originalText',
  'body',
  'metadata',
  'createdAt',
  'mentions',
  'attachments',
  'formatRanges'
])

function unknownFields(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([key]) => !KNOWN_MARK_FIELDS.has(key)))
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
