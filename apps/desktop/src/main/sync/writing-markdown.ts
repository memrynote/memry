/**
 * The Yjs half of writing tools in markdown (`@memry/shared` writing-tools/
 * markdown.ts has the text half and the format).
 *
 * The Y.Doc keeps alternatives and ghosts anchored with relative positions, so
 * a range follows edits while the note is open. The file keeps them as
 * comment markers. Both directions go through sentinel characters in the
 * fragment's text, because only the fragment knows which markdown character a
 * Yjs position became:
 *
 * - write: resolve each record's anchors on a detached snapshot, insert a
 *   sentinel at each end, serialize, then turn sentinels into comments.
 * - seed: markers become sentinels before the parse, so they land in the
 *   fragment's text; each one is read off as an anchor and deleted.
 *
 * @module sync/writing-markdown
 */

import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  createSentinelAllocator,
  readCriticMarkupMarksFromYDoc,
  serializeCriticMarkup,
  isWritingAlternativeId,
  readWritingAlternativesFromYDoc,
  readWritingGhostsFromYDoc,
  readWritingOverflowFromYDoc,
  writeWritingAlternativesToYDoc,
  writeWritingGhostsToYDoc,
  writeWritingOverflowToYDoc,
  type WritingAlternative,
  type WritingAnchor,
  type WritingFrontmatter,
  type WritingGhost,
  type WritingMarker,
  type WritingOverflowItem,
  type WritingSentinelMap,
  type WritingVariant
} from '@memry/shared'
// Types only: the converter loads lazily (blocknote-converter-loader.ts), and
// the write-back hands its functions in.
import type * as BlockNoteConverter from './blocknote-converter'

interface TextRun {
  type: Y.XmlText
  plain: string
}

/** Inline embeds count as one character, as they do in Yjs indices. */
function plainTextOf(type: Y.XmlText): string {
  return (type.toDelta() as Array<{ insert: unknown }>)
    .map((op) => (typeof op.insert === 'string' ? op.insert : '\ufffc'))
    .join('')
}

/** Every text run of the fragment, in document order. */
function collectTextRuns(parent: Y.XmlFragment | Y.XmlElement, runs: TextRun[] = []): TextRun[] {
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText) runs.push({ type: child, plain: plainTextOf(child) })
    else if (child instanceof Y.XmlElement) collectTextRuns(child, runs)
  }
  return runs
}

interface RunPosition {
  run: number
  index: number
}

function comparePositions(a: RunPosition, b: RunPosition): number {
  return a.run - b.run || a.index - b.index
}

function textBetween(runs: TextRun[], start: RunPosition, end: RunPosition): string {
  if (start.run === end.run) return runs[start.run].plain.slice(start.index, end.index)
  let text = runs[start.run].plain.slice(start.index)
  for (let run = start.run + 1; run < end.run; run++) text += runs[run].plain
  return text + runs[end.run].plain.slice(0, end.index)
}

// ----------------------------------------------------------------------------
// Write: anchors -> sentinels
// ----------------------------------------------------------------------------

export interface EncodedWritingRanges {
  sentinels: WritingSentinelMap
  /** Alternatives that resolved to a range, with the text the body shows for each. */
  alternatives: Array<{ record: WritingAlternative; shownText: string }>
}

interface ResolvedRange {
  kind: WritingMarker['kind']
  key: string
  start: RunPosition
  end: RunPosition
}

function resolveRange(
  doc: Y.Doc,
  runIndex: Map<Y.XmlText, number>,
  anchorStart: WritingAnchor,
  anchorEnd: WritingAnchor
): { start: RunPosition; end: RunPosition } | null {
  try {
    const start = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(anchorStart),
      doc
    )
    const end = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(anchorEnd),
      doc
    )
    if (!start || !end) return null
    if (!(start.type instanceof Y.XmlText) || !(end.type instanceof Y.XmlText)) return null
    const startRun = runIndex.get(start.type)
    const endRun = runIndex.get(end.type)
    if (startRun === undefined || endRun === undefined) return null
    const range = {
      start: { run: startRun, index: start.index },
      end: { run: endRun, index: end.index }
    }
    return comparePositions(range.start, range.end) < 0 ? range : null
  } catch {
    return null
  }
}

/**
 * Insert a sentinel at both ends of every alternative and ghost that still
 * resolves on `snapshot`, which must be a throwaway copy: the inserts are
 * real edits. Records whose range no longer resolves (its text was deleted)
 * are left out, and so leave the file.
 */
export function insertWritingSentinels(
  snapshot: Y.Doc,
  fragmentName: string,
  alternatives: WritingAlternative[],
  ghosts: WritingGhost[]
): EncodedWritingRanges {
  const runs = collectTextRuns(snapshot.getXmlFragment(fragmentName))
  const runIndex = new Map(runs.map((run, index) => [run.type, index]))
  const allocate = createSentinelAllocator(runs.map((run) => run.plain).join(''))

  const ranges: ResolvedRange[] = []
  const shown: EncodedWritingRanges['alternatives'] = []
  for (const record of alternatives) {
    if (!isWritingAlternativeId(record.id)) continue
    const range = resolveRange(snapshot, runIndex, record.anchorStart, record.anchorEnd)
    if (!range) continue
    ranges.push({ kind: 'alt', key: record.id, ...range })
    shown.push({ record, shownText: textBetween(runs, range.start, range.end) })
  }
  ghosts.forEach((record, index) => {
    const range = resolveRange(snapshot, runIndex, record.anchorStart, record.anchorEnd)
    if (range) ranges.push({ kind: 'ghost', key: `g${index}`, ...range })
  })

  const sentinels: WritingSentinelMap = new Map()
  const emittedAlternatives = new Set<string>()
  // At one position: closes before opens, the inner range's close first, the
  // outer range's open first, so ranges that touch or nest stay well formed.
  const inserts = new Map<
    Y.XmlText,
    Map<number, Array<{ char: string; order: [number, number, number] }>>
  >()
  const queue = (position: RunPosition, char: string, order: [number, number, number]): void => {
    const type = runs[position.run].type
    let byIndex = inserts.get(type)
    if (!byIndex) inserts.set(type, (byIndex = new Map()))
    const list = byIndex.get(position.index) ?? []
    list.push({ char, order })
    byIndex.set(position.index, list)
  }
  for (const range of ranges) {
    const open = allocate()
    const close = open === null ? null : allocate()
    if (open === null || close === null) break
    sentinels.set(open, { kind: range.kind, key: range.key, open: true })
    sentinels.set(close, { kind: range.kind, key: range.key, open: false })
    if (range.kind === 'alt') emittedAlternatives.add(range.key)
    // Outer opens first: the one ending later. Inner closes first: the one starting later.
    queue(range.start, open, [1, -range.end.run, -range.end.index])
    queue(range.end, close, [0, -range.start.run, -range.start.index])
  }

  for (const [type, byIndex] of inserts) {
    const indices = [...byIndex.keys()].sort((a, b) => b - a)
    for (const index of indices) {
      const text = byIndex
        .get(index)!
        .sort(
          (a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2]
        )
        .map((entry) => entry.char)
        .join('')
      type.insert(index, text)
    }
  }

  return {
    sentinels,
    alternatives: shown.filter((entry) => emittedAlternatives.has(entry.record.id))
  }
}

/** The `writing` frontmatter for what the body carries plus the overflow list. */
export function writingFrontmatterFor(
  alternatives: EncodedWritingRanges['alternatives'],
  overflow: WritingOverflowItem[]
): WritingFrontmatter {
  return {
    alternatives: Object.fromEntries(
      alternatives.map(({ record, shownText }) => {
        const versions = record.variants.map((variant) =>
          variant.source === 'ai' ? { text: variant.text, ai: true } : { text: variant.text }
        )
        return [
          record.id,
          shownText === record.original ? { versions } : { original: record.original, versions }
        ]
      })
    ),
    overflow: [...overflow]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((item) => (item.label ? { text: item.text, label: item.label } : { text: item.text }))
  }
}

// ----------------------------------------------------------------------------
// Seed: sentinels -> anchors
// ----------------------------------------------------------------------------

interface SeededRange {
  kind: WritingMarker['kind']
  key: string
  anchorStart: WritingAnchor
  anchorEnd: WritingAnchor
  shownText: string
}

/**
 * Read every sentinel out of a freshly built fragment as an anchor and delete
 * it. A range whose sentinels did not both survive the parse (one sat where
 * the parser keeps no text) is dropped.
 */
function extractWritingRanges(
  fragment: Y.XmlFragment,
  sentinels: WritingSentinelMap
): SeededRange[] {
  if (sentinels.size === 0) return []
  const found = new Map<
    string,
    { start?: RunPosition; end?: RunPosition; kind: WritingMarker['kind'] }
  >()
  const runs = collectTextRuns(fragment)
  runs.forEach((run, runNumber) => {
    let removed = 0
    const hits: number[] = []
    for (let index = 0; index < run.plain.length; index++) {
      const marker = sentinels.get(run.plain[index])
      if (!marker) continue
      hits.push(index)
      const entry = found.get(marker.key) ?? { kind: marker.kind }
      const position = { run: runNumber, index: index - removed }
      if (marker.open) entry.start ??= position
      else entry.end ??= position
      found.set(marker.key, entry)
      removed++
    }
    for (let k = hits.length - 1; k >= 0; k--) run.type.delete(hits[k], 1)
    if (hits.length > 0) run.plain = plainTextOf(run.type)
  })

  const ranges: SeededRange[] = []
  for (const [key, { kind, start, end }] of found) {
    if (!start || !end || comparePositions(start, end) >= 0) continue
    // The anchors take the first and the last character, as the editor's do
    // (`anchorsForRange`). A range that opens at a run's end starts on the
    // next run's first character; one that closes at a run's start ends on
    // the previous run's last character.
    const first = { ...start }
    while (first.index >= runs[first.run].plain.length && first.run < end.run) {
      first.run++
      first.index = 0
    }
    const last = { run: end.run, index: end.index - 1 }
    while (last.index < 0 && last.run > first.run) {
      last.run--
      last.index = runs[last.run].plain.length - 1
    }
    if (last.index < 0 || first.index >= runs[first.run].plain.length) continue
    if (comparePositions(first, last) > 0) continue
    const startPosition = Y.createRelativePositionFromTypeIndex(runs[first.run].type, first.index)
    const lastPosition = Y.createRelativePositionFromTypeIndex(runs[last.run].type, last.index)
    ranges.push({
      kind,
      key,
      anchorStart: Y.relativePositionToJSON(startPosition) as WritingAnchor,
      anchorEnd: { ...(Y.relativePositionToJSON(lastPosition) as WritingAnchor), assoc: -1 },
      shownText: textBetween(runs, first, { run: last.run, index: last.index + 1 })
    })
  }
  return ranges
}

function uniqueId(preferred: string, taken: Set<string>): string {
  let id = preferred
  for (let n = 1; taken.has(id); n++) id = `${preferred}-${n}`
  taken.add(id)
  return id
}

/**
 * Write the doc's writing tools records from a seed: ranges from the
 * sentinels now in `fragment`, versions and overflow from `frontmatter`.
 * `frontmatter` undefined means the caller only has the body (a template
 * apply, an agent edit); versions and overflow then come from the records
 * already on the doc. Ids and timestamps of records that match ones already
 * there are kept, so re-seeding an unchanged file changes nothing.
 */
export function applyWritingSeed(
  fragment: Y.XmlFragment,
  sentinels: WritingSentinelMap,
  frontmatter: WritingFrontmatter | undefined
): void {
  const doc = fragment.doc
  if (!doc) return
  const existingAlternatives = new Map(
    readWritingAlternativesFromYDoc(doc).map((record) => [record.id, record])
  )
  const existingOverflow = readWritingOverflowFromYDoc(doc)
  const ranges = extractWritingRanges(fragment, sentinels)

  const alternatives: WritingAlternative[] = []
  const ghosts: WritingGhost[] = []
  let ghostCount = 0
  for (const range of ranges) {
    if (range.kind === 'ghost') {
      ghosts.push({
        id: `ghost-${ghostCount++}`,
        anchorStart: range.anchorStart,
        anchorEnd: range.anchorEnd
      })
      continue
    }
    const existing = existingAlternatives.get(range.key)
    const spec = frontmatter
      ? frontmatter.alternatives[range.key]
      : existing && {
          ...(existing.original === range.shownText ? {} : { original: existing.original }),
          versions: existing.variants.map((variant) => ({
            text: variant.text,
            ...(variant.source === 'ai' ? { ai: true } : {})
          }))
        }
    if (!spec || spec.versions.length === 0) continue

    const original = spec.original ?? range.shownText
    const taken = new Set<string>()
    const variants: WritingVariant[] = spec.versions.map((version, index) => {
      const match = existing?.variants.find(
        (variant) => variant.text === version.text && !taken.has(variant.id)
      )
      return {
        id: uniqueId(match?.id ?? `v${index}`, taken),
        text: version.text,
        source: version.ai ? 'ai' : 'user',
        createdAt: match?.createdAt ?? 0
      }
    })
    const active =
      spec.original === undefined
        ? undefined
        : variants.find((variant) => variant.text === range.shownText)
    alternatives.push({
      id: range.key,
      anchorStart: range.anchorStart,
      anchorEnd: range.anchorEnd,
      original,
      variants,
      activeVariantId: active?.id ?? null
    })
  }

  writeWritingAlternativesToYDoc(doc, alternatives)
  writeWritingGhostsToYDoc(doc, ghosts)
  if (!frontmatter) return

  // File order is display order (newest first); the timestamps only carry it.
  // The file holds plain text. An item whose text is unchanged keeps the
  // formatted copy (`html`) the doc already has for it.
  const takenOverflow = new Set<string>()
  const overflow = frontmatter.overflow.map((item, index): WritingOverflowItem => {
    const match = existingOverflow.find(
      (existing) => existing.text === item.text && !takenOverflow.has(existing.id)
    )
    return {
      id: uniqueId(match?.id ?? `overflow-${index}`, takenOverflow),
      text: item.text,
      ...(match?.html ? { html: match.html } : {}),
      ...(item.label ? { label: item.label } : {}),
      createdAt: frontmatter.overflow.length - index
    }
  })
  writeWritingOverflowToYDoc(doc, overflow)
}

/** True when the doc holds a range the file has to carry as markers. */
function hasWritingRanges(doc: Y.Doc): boolean {
  return (
    readWritingAlternativesFromYDoc(doc).length > 0 || readWritingGhostsFromYDoc(doc).length > 0
  )
}

// ----------------------------------------------------------------------------
// The file body
// ----------------------------------------------------------------------------

/** What the vault file gets for a doc: the body, and the `writing` frontmatter beside it. */
export interface NoteBody {
  markdown: string
  writing: WritingFrontmatter
}

/**
 * The body with its CriticMarkup and, when the doc has alternatives or
 * ghosts, the writing tools markers; plus the `writing` frontmatter.
 */
export async function serializeNoteBody(
  doc: Y.Doc,
  options: Parameters<typeof BlockNoteConverter.yDocToMarkdown>[2],
  converter: Pick<typeof BlockNoteConverter, 'yDocToMarkdown' | 'yDocToMarkdownWithWritingRanges'>
): Promise<NoteBody | null> {
  const criticMarks = readCriticMarkupMarksFromYDoc(doc)
  const overflow = readWritingOverflowFromYDoc(doc)
  if (hasWritingRanges(doc)) {
    const ranged = await converter.yDocToMarkdownWithWritingRanges(
      doc,
      CRDT_FRAGMENT_NAME,
      criticMarks,
      options
    )
    if (ranged === null) return null
    if (ranged) {
      return {
        markdown: ranged.markdown,
        writing: writingFrontmatterFor(ranged.alternatives, overflow)
      }
    }
  }
  const plain = await converter.yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, options)
  if (plain === null) return null
  return {
    markdown: serializeCriticMarkup(plain, criticMarks),
    writing: writingFrontmatterFor([], overflow)
  }
}
