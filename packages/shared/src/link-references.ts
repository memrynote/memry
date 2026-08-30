/**
 * Reference-style links, carried across the round trip (#1909).
 *
 * `[docs][d]` plus `[d]: https://example.com` is two markdown constructs that
 * the editor's document model has no room for. The parser resolves the
 * reference into an ordinary link and the definition is a block with no
 * BlockNote equivalent, so it is dropped: a foreign file came back with the
 * destination inlined at every use site and the author's definition gone.
 *
 * The shape of the fix is CriticMarkup's (`critic-markup/parser.ts`): strip the
 * construct on the way in, hand the editor plain markdown, keep what was
 * stripped beside the document in the shared doc, and put it back on the way
 * out. Nothing here reaches the editor's schema, so a note written by this
 * build still opens on one that predates it — an older build simply ignores the
 * two arrays and behaves exactly as it does today.
 *
 * Definitions are re-emitted at the END of the document. CommonMark resolves a
 * definition wherever it sits, so this loses no meaning; it costs the position
 * of a definition an author had written mid-file, which is the cheap half of a
 * trade whose expensive half is deleting it.
 */

import { createFenceTracker } from './markdown-fences'

export interface LinkReferenceDefinition {
  /** Case-folded, whitespace-collapsed label — the key a usage matches on. */
  label: string
  /** Destination with any angle brackets removed, as the parsed link carries it. */
  destination: string
  /** The author's definition line, byte for byte, title and all. */
  raw: string
  /**
   * Blank lines between the previous definition and this one when the two were
   * adjacent, so a grouped block of definitions comes back grouped. `null` when
   * something else sat between them.
   */
  gapBefore: number | null
}

export interface LinkReferenceUsage {
  label: string
  destination: string
  /** The link text as written, which is what the serialized inline link carries. */
  text: string
  /** The author's reference span: `[docs][d]`, `[docs][]` or `[docs]`. */
  raw: string
}

export interface StrippedLinkReferences {
  /** The body with every definition line removed. */
  markdown: string
  definitions: LinkReferenceDefinition[]
  usages: LinkReferenceUsage[]
}

// A footnote definition (`[^1]: …`) is the same shape and is emphatically not a
// link, so the label may not open with a caret.
const DEFINITION_LINE =
  /^ {0,3}\[(?!\^)((?:[^\\[\]]|\\.)+)\]:[ \t]*(<[^<>]*>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^()]*\)))?[ \t]*$/

const REFERENCE_SPAN = /(!?)\[((?:[^\\[\]]|\\.)*)\](\[((?:[^\\[\]]|\\.)*)\]|\()?/g

export function normalizeLinkReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function stripLinkReferenceDefinitions(markdown: string): StrippedLinkReferences {
  if (!markdown.includes(']:')) {
    return { markdown, definitions: [], usages: [] }
  }

  const lines = markdown.split('\n')
  const fences = createFenceTracker()
  const definitions: LinkReferenceDefinition[] = []
  const kept: string[] = []
  // A definition has to start a block: a matching line in the middle of a
  // paragraph is a continuation line and stays the author's prose.
  let previousLineOpensABlock = true
  let previousDefinitionLine = -1

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const inFence = fences.consume(line)
    const match = inFence ? null : line.match(DEFINITION_LINE)

    if (!match || !previousLineOpensABlock) {
      kept.push(line)
      previousLineOpensABlock = inFence ? false : line.trim() === ''
      continue
    }

    const blanksSincePrevious =
      previousDefinitionLine === -1 ? null : countBlankRun(lines, previousDefinitionLine + 1, index)

    definitions.push({
      label: normalizeLinkReferenceLabel(match[1]),
      destination: match[2].replace(/^<|>$/g, ''),
      raw: line,
      gapBefore: blanksSincePrevious
    })
    previousDefinitionLine = index

    // Drop the blank line the definition leaves behind, so removing it does not
    // grow the document by an empty paragraph the author never wrote.
    if (kept[kept.length - 1]?.trim() === '' && lines[index + 1]?.trim() === '') {
      index++
    }
    previousLineOpensABlock = true
  }

  if (definitions.length === 0) return { markdown, definitions: [], usages: [] }

  return {
    markdown: kept.join('\n'),
    definitions,
    usages: collectUsages(kept, definitions)
  }
}

export function restoreLinkReferences(
  markdown: string,
  definitions: LinkReferenceDefinition[],
  usages: LinkReferenceUsage[]
): string {
  if (definitions.length === 0) return markdown

  let body = markdown
  let searchFrom = 0
  for (const usage of usages) {
    for (const needle of [
      `[${usage.text}](${usage.destination})`,
      `[${usage.text}](<${usage.destination}>)`
    ]) {
      const at = body.indexOf(needle, searchFrom)
      if (at === -1 || body[at - 1] === '!') continue
      body = body.slice(0, at) + usage.raw + body.slice(at + needle.length)
      searchFrom = at + usage.raw.length
      break
    }
  }

  let block = ''
  for (const [index, definition] of definitions.entries()) {
    if (index > 0) block += '\n'.repeat((definition.gapBefore ?? 1) + 1)
    block += definition.raw
  }

  const trimmed = body.replace(/\n+$/, '')
  return trimmed === '' ? block : `${trimmed}\n\n${block}`
}

// ---------------------------------------------------------------------------
// Shared-doc channel
// ---------------------------------------------------------------------------

export const LINK_REFERENCE_DEFINITIONS_ARRAY = 'linkReferenceDefinitions'
export const LINK_REFERENCE_USAGES_ARRAY = 'linkReferenceUsages'

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

export function writeLinkReferencesToYDoc(
  doc: YDocLike,
  definitions: LinkReferenceDefinition[],
  usages: LinkReferenceUsage[]
): void {
  replaceArray(doc.getArray(LINK_REFERENCE_DEFINITIONS_ARRAY), definitions as unknown[])
  replaceArray(doc.getArray(LINK_REFERENCE_USAGES_ARRAY), usages as unknown[])
}

export function readLinkReferencesFromYDoc(doc: YDocLike): {
  definitions: LinkReferenceDefinition[]
  usages: LinkReferenceUsage[]
} {
  return {
    definitions: readArray(doc.getArray(LINK_REFERENCE_DEFINITIONS_ARRAY)).flatMap((value) => {
      const definition = normalizeDefinition(value)
      return definition ? [definition] : []
    }),
    usages: readArray(doc.getArray(LINK_REFERENCE_USAGES_ARRAY)).flatMap((value) => {
      const usage = normalizeUsage(value)
      return usage ? [usage] : []
    })
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function countBlankRun(lines: string[], from: number, to: number): number | null {
  for (let index = from; index < to; index++) {
    if (lines[index].trim() !== '') return null
  }
  return to - from
}

function collectUsages(
  lines: string[],
  definitions: LinkReferenceDefinition[]
): LinkReferenceUsage[] {
  const byLabel = new Map(definitions.map((definition) => [definition.label, definition]))
  const fences = createFenceTracker()
  const usages: LinkReferenceUsage[] = []

  for (const line of lines) {
    if (fences.consume(line)) continue

    REFERENCE_SPAN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = REFERENCE_SPAN.exec(line)) !== null) {
      const [span, bang, text, tail] = match
      if (bang === '!' || tail === '(') continue
      // `[[wiki]]` is not two shortcut references.
      if (line[match.index - 1] === '[' || line[match.index + span.length] === ']') continue

      const label = normalizeLinkReferenceLabel(match[4] ?? '') || normalizeLinkReferenceLabel(text)
      const definition = byLabel.get(label)
      if (!definition) continue

      usages.push({ label, destination: definition.destination, text, raw: span })
    }
  }

  return usages
}

function replaceArray(array: YArrayLike, next: unknown[]): void {
  const current = readArray(array)
  if (JSON.stringify(current) === JSON.stringify(next)) return
  if (array.length > 0) array.delete(0, array.length)
  if (next.length > 0) array.push(next)
}

function readArray(array: YArrayLike): unknown[] {
  if (array.toArray) return array.toArray()
  const values: unknown[] = []
  for (let index = 0; index < array.length; index++) values.push(array.get(index))
  return values
}

function normalizeDefinition(value: unknown): LinkReferenceDefinition | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.label !== 'string') return null
  if (typeof record.destination !== 'string') return null
  if (typeof record.raw !== 'string') return null
  const gap = record.gapBefore
  return {
    label: record.label,
    destination: record.destination,
    raw: record.raw,
    gapBefore: typeof gap === 'number' && Number.isFinite(gap) && gap >= 0 ? gap : null
  }
}

function normalizeUsage(value: unknown): LinkReferenceUsage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.label !== 'string') return null
  if (typeof record.destination !== 'string') return null
  if (typeof record.text !== 'string') return null
  if (typeof record.raw !== 'string') return null
  return {
    label: record.label,
    destination: record.destination,
    text: record.text,
    raw: record.raw
  }
}
