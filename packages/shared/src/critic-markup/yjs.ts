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

/** The element keys this build writes. Any other key belongs to a newer build and is kept. */
const MARK_KEYS: ReadonlySet<string> = new Set([
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

function isCriticMarkupKind(value: unknown): value is CriticMarkupKind {
  return VALID_KINDS.has(value)
}

/**
 * The valid marks in array order, one per id: the first copy wins (protocol
 * 12.5.1). Concurrent edits of one mark leave two copies, and Yjs orders them
 * the same on every replica.
 */
export function readCriticMarkupMarksFromYDoc(doc: YDocLike): CriticMarkupMark[] {
  const seen = new Set<string>()
  return readArray(doc.getArray(CRITIC_MARKUP_MARKS_ARRAY)).flatMap((value) => {
    const mark = normalizeCriticMarkupMark(value)
    if (!mark || seen.has(mark.id)) return []
    seen.add(mark.id)
    return [mark]
  })
}

/**
 * Past this many array operations a write rewrites the whole array: each Yjs
 * operation walks the array from its start, so the cost stays linear.
 */
const MAX_ARRAY_OPERATIONS = 64

/**
 * Makes the root hold `marks`, touching only the elements that change
 * (protocol 12.5.1): it deletes invalid elements, later copies of an id and
 * ids `marks` drops, and inserts a new id after the furthest existing mark
 * before it in `marks`. It replaces an element only when the stored mark, read
 * as this build reads it, differs from the new one in more than its offsets:
 * the window moves offsets with its typing and never writes them alone
 * (#4425). A replaced element keeps the keys this build does not know.
 */
export function writeCriticMarkupMarksToYDoc(doc: YDocLike, marks: CriticMarkupMark[]): void {
  const array = doc.getArray(CRITIC_MARKUP_MARKS_ARRAY)
  const next = new Map<string, Record<string, unknown>>()
  for (const mark of marks) {
    const normalized = normalizeCriticMarkupMark(mark)
    if (normalized && !next.has(normalized.id)) {
      next.set(normalized.id, toSerializableMark(normalized))
    }
  }

  const values = readArray(array)
  const keptIds = new Set<string>()
  const keep = values.map((value) => {
    const id = normalizeCriticMarkupMark(value)?.id
    if (id === undefined || !next.has(id) || keptIds.has(id)) return false
    keptIds.add(id)
    return true
  })

  const stored = values.filter((_, index) => keep[index])
  const result = [...stored]
  const replaced = stored.map(() => false)
  const indexOf = new Map([...keptIds].map((id, index) => [id, index]))
  // New marks keyed by the kept element they follow (-1: the start).
  const inserts = new Map<number, Record<string, unknown>[]>()
  let anchor = -1
  for (const [id, mark] of next) {
    const index = indexOf.get(id)
    if (index === undefined) {
      const group = inserts.get(anchor)
      if (group) group.push(mark)
      else inserts.set(anchor, [mark])
      continue
    }
    if (!sameMarkApartFromOffsets(stored[index], mark)) {
      result[index] = { ...mark, ...unknownKeys(stored[index]) }
      replaced[index] = true
    }
    anchor = Math.max(anchor, index)
  }

  const deletes = runsOf(keep.map((kept) => !kept))
  const replaces = runsOf(replaced)
  const operations = deletes.length + 2 * replaces.length + inserts.size
  if (operations > MAX_ARRAY_OPERATIONS) {
    const whole = [
      ...(inserts.get(-1) ?? []),
      ...result.flatMap((element, index) => [element, ...(inserts.get(index) ?? [])])
    ]
    if (values.length > 0) array.delete(0, values.length)
    if (whole.length > 0) array.insert(0, whole)
    return
  }
  for (const [start, end] of deletes.toReversed()) array.delete(start, end - start)
  for (const [start, end] of replaces) {
    array.delete(start, end - start)
    array.insert(start, result.slice(start, end))
  }
  for (const [after, group] of [...inserts].toSorted(([a], [b]) => b - a)) {
    array.insert(after + 1, group)
  }
}

/** The `[start, end)` runs of `true`, in order. */
function runsOf(flags: boolean[]): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  flags.forEach((flag, index) => {
    if (!flag) return
    const last = runs.at(-1)
    if (last?.[1] === index) last[1] = index + 1
    else runs.push([index, index + 1])
  })
  return runs
}

/** Whether `stored`, read as this build reads it, equals `mark` apart from the offsets. */
function sameMarkApartFromOffsets(stored: unknown, mark: Record<string, unknown>): boolean {
  const current = normalizeCriticMarkupMark(stored)
  if (!current) return false
  const { start: _start, end: _end, ...rest } = toSerializableMark(current)
  const { start: _nextStart, end: _nextEnd, ...nextRest } = mark
  return sameValue(rest, nextRest)
}

function unknownKeys(element: unknown): Record<string, unknown> {
  if (!isObject(element)) return {}
  return Object.fromEntries(Object.entries(element).filter(([key]) => !MARK_KEYS.has(key)))
}

/** Deep equality that ignores object key order. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValue(item, b[index]))
    )
  }
  if (!isObject(a) || !isObject(b)) return Object.is(a, b)
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
  )
}

function readArray(array: YArrayLike): unknown[] {
  return array.toArray ? array.toArray() : readArrayLike(array)
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
