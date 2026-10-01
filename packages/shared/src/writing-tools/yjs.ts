/**
 * Writing tools side data on a note's Y.Doc.
 *
 * Alternatives, ghosted ranges and the overflow list are not part of the note
 * body. They live in three top-level Y.Arrays next to the prosemirror
 * fragment, the same way CriticMarkup marks do (`critic-markup/yjs.ts`):
 *
 * - Older app versions never read these roots, so they ignore them, and the
 *   arrays still ride the normal CRDT sync pipeline.
 * - Reads normalize every entry and drop anything unknown or malformed, so a
 *   newer client writing extra fields, or a corrupt entry, never breaks a read.
 * - Writes diff by record id and are idempotent: writing what is already there
 *   is a no-op, and concurrent edits to different records do not clobber each
 *   other the way a whole-array replace would.
 *
 * Anchors are `Y.RelativePosition` JSON (`Y.relativePositionToJSON`) taken
 * against the prosemirror fragment. They survive edits around the range, but
 * not a re-seed of the doc from the markdown file (an external edit that
 * rebuilds the fragment) or a doc compaction, which mint new item ids. That is
 * the known limit of any side data that is not encoded in the markdown.
 */

export const WRITING_ALTERNATIVES_ARRAY = 'writingAlternatives'
export const WRITING_GHOSTS_ARRAY = 'writingGhosts'
export const WRITING_OVERFLOW_ARRAY = 'writingOverflow'

/** A Yjs item id as `Y.relativePositionToJSON` writes it. */
export interface WritingAnchorId {
  client: number
  clock: number
}

/** `Y.relativePositionToJSON` output: the shape `Y.createRelativePositionFromJSON` reads. */
export interface WritingAnchor {
  type?: WritingAnchorId
  tname?: string
  item?: WritingAnchorId
  assoc?: number
}

export type WritingVariantSource = 'user' | 'ai'

export interface WritingVariant {
  id: string
  text: string
  source: WritingVariantSource
  createdAt: number
}

export interface WritingAlternative {
  id: string
  anchorStart: WritingAnchor
  anchorEnd: WritingAnchor
  /** The text the range held when the alternative was made. Always restorable. */
  original: string
  variants: WritingVariant[]
  /** The variant shown in the body, or null while the original is shown. */
  activeVariantId: string | null
}

export interface WritingGhost {
  id: string
  anchorStart: WritingAnchor
  anchorEnd: WritingAnchor
}

export interface WritingOverflowItem {
  id: string
  /** Plain text: the fallback every build can show and insert */
  text: string
  /**
   * The stashed selection as ProseMirror clipboard HTML, so formatting, links
   * and inline content survive the trip out of the note and back. Optional:
   * typed items and items from older builds have text only.
   */
  html?: string
  label?: string
  createdAt: number
}

/** Upper bound on a stored overflow item's HTML; larger values are dropped to text. */
export const WRITING_OVERFLOW_HTML_MAX = 200_000

interface YArrayLike {
  length: number
  get(index: number): unknown
  toArray?: () => unknown[]
  delete(index: number, length: number): void
  push(values: unknown[]): void
}

interface YDocLike {
  getArray(name: string): YArrayLike
  transact?: (fn: () => void) => void
}

const VARIANT_SOURCES = new Set<WritingVariantSource>(['user', 'ai'])

export function readWritingAlternativesFromYDoc(doc: YDocLike): WritingAlternative[] {
  return readRecords(doc, WRITING_ALTERNATIVES_ARRAY, normalizeWritingAlternative)
}

export function writeWritingAlternativesToYDoc(
  doc: YDocLike,
  alternatives: WritingAlternative[]
): void {
  writeRecords(
    doc,
    WRITING_ALTERNATIVES_ARRAY,
    alternatives,
    normalizeWritingAlternative,
    overlayAlternative
  )
}

export function readWritingGhostsFromYDoc(doc: YDocLike): WritingGhost[] {
  return readRecords(doc, WRITING_GHOSTS_ARRAY, normalizeWritingGhost)
}

export function writeWritingGhostsToYDoc(doc: YDocLike, ghosts: WritingGhost[]): void {
  writeRecords(doc, WRITING_GHOSTS_ARRAY, ghosts, normalizeWritingGhost, (raw, ghost) =>
    overlayKnownFields(raw, ghost, GHOST_KEYS)
  )
}

export function readWritingOverflowFromYDoc(doc: YDocLike): WritingOverflowItem[] {
  return readRecords(doc, WRITING_OVERFLOW_ARRAY, normalizeWritingOverflowItem)
}

export function writeWritingOverflowToYDoc(doc: YDocLike, items: WritingOverflowItem[]): void {
  writeRecords(doc, WRITING_OVERFLOW_ARRAY, items, normalizeWritingOverflowItem, (raw, item) =>
    overlayKnownFields(raw, item, OVERFLOW_KEYS)
  )
}

function readArrayValues(array: YArrayLike): unknown[] {
  if (array.toArray) return array.toArray()
  const values: unknown[] = []
  for (let index = 0; index < array.length; index++) values.push(array.get(index))
  return values
}

/**
 * Normalized records, one per id. Two devices can each push a record with the
 * same id while offline; the later entry in array order wins, which is the
 * order Yjs resolved the concurrent inserts into on every peer.
 */
function readRecords<T extends { id: string }>(
  doc: YDocLike,
  name: string,
  normalize: (value: unknown) => T | null
): T[] {
  const byId = new Map<string, T>()
  for (const value of readArrayValues(doc.getArray(name))) {
    const record = normalize(value)
    if (!record) continue
    byId.delete(record.id)
    byId.set(record.id, record)
  }
  return [...byId.values()]
}

const ALTERNATIVE_KEYS = [
  'id',
  'anchorStart',
  'anchorEnd',
  'original',
  'variants',
  'activeVariantId'
] as const
const VARIANT_KEYS = ['id', 'text', 'source', 'createdAt'] as const
const GHOST_KEYS = ['id', 'anchorStart', 'anchorEnd'] as const
const OVERFLOW_KEYS = ['id', 'text', 'label', 'createdAt'] as const

/**
 * The stored object with this build's fields replaced by `record`. Fields a
 * newer build added survive an edit made here; the fields this build owns
 * are authoritative, including ones `record` leaves out (a cleared label).
 */
function overlayKnownFields(
  raw: Record<string, unknown>,
  record: object,
  knownKeys: readonly string[]
): Record<string, unknown> {
  const unknown = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !knownKeys.includes(key))
  )
  return { ...unknown, ...record }
}

/**
 * An alternative overlaid on its stored object, variant by variant. Variants
 * this build cannot read (a newer source kind) are kept as they were, since
 * nobody here could have meant to remove them.
 */
function overlayAlternative(
  raw: Record<string, unknown>,
  alternative: WritingAlternative
): Record<string, unknown> {
  const rawVariants = Array.isArray(raw.variants) ? raw.variants : []
  const rawById = new Map<string, Record<string, unknown>>()
  const unreadable: unknown[] = []
  for (const entry of rawVariants) {
    const id = recordId(entry)
    if (id === null) continue
    if (normalizeWritingVariant(entry) === null) unreadable.push(entry)
    else rawById.set(id, entry as Record<string, unknown>)
  }
  const known = new Set(alternative.variants.map((variant) => variant.id))
  const variants = [
    ...alternative.variants.map((variant) => {
      const stored = rawById.get(variant.id)
      return stored ? overlayKnownFields(stored, variant, VARIANT_KEYS) : variant
    }),
    ...unreadable.filter((entry) => !known.has(recordId(entry) ?? ''))
  ]
  return { ...overlayKnownFields(raw, alternative, ALTERNATIVE_KEYS), variants }
}

function writeRecords<T extends { id: string }>(
  doc: YDocLike,
  name: string,
  records: T[],
  normalize: (value: unknown) => T | null,
  overlay: (raw: Record<string, unknown>, record: T) => Record<string, unknown>
): void {
  const array = doc.getArray(name)
  const next = new Map<string, { record: T; json: string }>()
  for (const record of records) {
    const normalized = normalize(record)
    if (normalized)
      next.set(normalized.id, { record: normalized, json: JSON.stringify(normalized) })
  }

  const current = readArrayValues(array)
  const kept = new Set<string>()
  const stored = new Map<string, Record<string, unknown>>()
  const deletions: number[] = []
  current.forEach((value, index) => {
    const id = recordId(value)
    const wanted = id === null ? undefined : next.get(id)
    // An unknown entry (no id, or one this build cannot normalize) is left
    // alone: it may be a record a newer build understands.
    if (id === null || (wanted === undefined && normalize(value) === null)) return
    stored.set(id, value as Record<string, unknown>)
    if (wanted !== undefined && !kept.has(id) && JSON.stringify(normalize(value)) === wanted.json) {
      kept.add(id)
      return
    }
    deletions.push(index)
  })
  const insertions = [...next.entries()]
    .filter(([id]) => !kept.has(id))
    .map(([id, { record, json }]) => {
      const raw = stored.get(id)
      return raw ? overlay(raw, record) : (JSON.parse(json) as unknown)
    })

  if (deletions.length === 0 && insertions.length === 0) return

  const apply = (): void => {
    for (let index = deletions.length - 1; index >= 0; index--) array.delete(deletions[index], 1)
    if (insertions.length > 0) array.push(insertions)
  }
  if (doc.transact) doc.transact(apply)
  else apply()
}

function recordId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeAnchorId(value: unknown): WritingAnchorId | null {
  if (!value || typeof value !== 'object') return null
  const { client, clock } = value as Record<string, unknown>
  if (!isFiniteNumber(client) || !isFiniteNumber(clock)) return null
  return { client, clock }
}

export function normalizeWritingAnchor(value: unknown): WritingAnchor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const anchor: WritingAnchor = {}
  if (raw.type !== undefined && raw.type !== null) {
    const type = normalizeAnchorId(raw.type)
    if (!type) return null
    anchor.type = type
  }
  if (raw.tname !== undefined && raw.tname !== null) {
    if (typeof raw.tname !== 'string') return null
    anchor.tname = raw.tname
  }
  if (raw.item !== undefined && raw.item !== null) {
    const item = normalizeAnchorId(raw.item)
    if (!item) return null
    anchor.item = item
  }
  if (raw.assoc !== undefined && raw.assoc !== null) {
    if (!isFiniteNumber(raw.assoc)) return null
    anchor.assoc = raw.assoc
  }
  if (!anchor.item && !anchor.type && anchor.tname === undefined) return null
  return anchor
}

function normalizeWritingVariant(value: unknown): WritingVariant | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null
  if (typeof raw.text !== 'string') return null
  if (typeof raw.source !== 'string' || !VARIANT_SOURCES.has(raw.source as WritingVariantSource)) {
    return null
  }
  if (!isFiniteNumber(raw.createdAt)) return null
  return {
    id: raw.id,
    text: raw.text,
    source: raw.source as WritingVariantSource,
    createdAt: raw.createdAt
  }
}

/**
 * A record with no usable variant is no alternative at all: the UI deletes a
 * record when its last variant goes, so reading one back means a write was
 * cut short or came from a build with other variant kinds. Both read as absent.
 */
export function normalizeWritingAlternative(value: unknown): WritingAlternative | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = recordId(raw)
  if (!id) return null
  const anchorStart = normalizeWritingAnchor(raw.anchorStart)
  const anchorEnd = normalizeWritingAnchor(raw.anchorEnd)
  if (!anchorStart || !anchorEnd) return null
  if (typeof raw.original !== 'string') return null
  if (!Array.isArray(raw.variants)) return null

  const seen = new Set<string>()
  const variants = raw.variants.flatMap((entry) => {
    const variant = normalizeWritingVariant(entry)
    if (!variant || seen.has(variant.id)) return []
    seen.add(variant.id)
    return [variant]
  })
  if (variants.length === 0) return null

  const activeVariantId =
    typeof raw.activeVariantId === 'string' && seen.has(raw.activeVariantId)
      ? raw.activeVariantId
      : null

  return { id, anchorStart, anchorEnd, original: raw.original, variants, activeVariantId }
}

export function normalizeWritingGhost(value: unknown): WritingGhost | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = recordId(raw)
  if (!id) return null
  const anchorStart = normalizeWritingAnchor(raw.anchorStart)
  const anchorEnd = normalizeWritingAnchor(raw.anchorEnd)
  if (!anchorStart || !anchorEnd) return null
  return { id, anchorStart, anchorEnd }
}

export function normalizeWritingOverflowItem(value: unknown): WritingOverflowItem | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = recordId(raw)
  if (!id) return null
  if (typeof raw.text !== 'string' || raw.text.length === 0) return null
  if (!isFiniteNumber(raw.createdAt)) return null
  const html =
    typeof raw.html === 'string' &&
    raw.html.length > 0 &&
    raw.html.length <= WRITING_OVERFLOW_HTML_MAX
      ? raw.html
      : undefined
  return {
    id,
    text: raw.text,
    ...(html ? { html } : {}),
    ...(typeof raw.label === 'string' && raw.label.length > 0 ? { label: raw.label } : {}),
    createdAt: raw.createdAt
  }
}
