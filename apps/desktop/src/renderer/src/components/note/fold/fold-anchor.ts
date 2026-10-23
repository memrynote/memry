import type { FoldLayers } from '@memry/contracts/note-fold'

const PREFIX_CHARS = 40
const MIN_PARTIAL_CHARS = 12

/**
 * Plain, comparable text. The layers carry plain text while the editor's DOM
 * text can differ in markup-only ways (wiki-link brackets, link targets, list
 * or heading markers, emphasis marks, smart quotes, invisible characters), so
 * both sides go through this before they are compared.
 */
function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(
      /!?\[\[([^\]|]*)\|?([^\]]*)\]\]/g,
      (_, target: string, alias: string) => alias || target
    )
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:(?:#{1,6}|>|[-*+]|\d+[.)]|\[[ xX]\])\s+)+/, '')
    .replace(/[*_~`]+/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Where a paragraph sits among the note's non-empty blocks, for when its text no longer matches. */
export interface BlockPosition {
  index: number
  count: number
}

/** The paragraph's place among the note's headings and non-empty paragraphs, in reading order. */
export function paragraphPosition(layers: FoldLayers, hash: string): BlockPosition | undefined {
  let index = -1
  let count = 0
  for (const section of layers.sections) {
    if (section.heading !== null && section.heading.trim() !== '') count += 1
    for (const paragraph of section.paragraphs) {
      if (paragraph.text.trim() === '') continue
      if (paragraph.hash === hash) index = count
      count += 1
    }
  }
  return index === -1 ? undefined : { index, count }
}

/** Of several equally good matches, the one nearest where the paragraph was. */
function pick(candidates: readonly number[], expected: number | undefined): number {
  if (expected === undefined) return candidates[0]
  return candidates.reduce((best, next) =>
    Math.abs(next - expected) < Math.abs(best - expected) ? next : best
  )
}

/**
 * Which editor block holds a folded paragraph: the index into `blockTexts`, or
 * -1. Tries, in order, the whole text, a shared start, a shared end, and one
 * text containing the other. When the text matches nothing (it was edited
 * since the snapshot) and `position` is given, the block at the same place in
 * the note stands in: the same index when the block counts agree, else the
 * proportional one. Empty blocks never match.
 */
export function findParagraphBlock(
  blockTexts: readonly string[],
  paragraphText: string,
  position?: BlockPosition
): number {
  const texts = blockTexts.map(normalize)
  const filled = texts.flatMap((text, index) => (text === '' ? [] : [index]))
  // Duplicates resolve to the one nearest the paragraph's place in the note.
  const expected =
    position && filled.length > 0
      ? filled[
          filled.length === position.count
            ? position.index
            : Math.round((position.index / Math.max(position.count - 1, 1)) * (filled.length - 1))
        ]
      : undefined

  const target = normalize(paragraphText)
  if (target !== '') {
    const partial = target.length >= MIN_PARTIAL_CHARS
    const edge = Math.min(PREFIX_CHARS, target.length)
    const stages: ((text: string) => boolean)[] = [
      (text) => text === target,
      ...(partial
        ? [
            (text: string) => text.startsWith(target.slice(0, edge)),
            (text: string) => text.endsWith(target.slice(-edge)),
            (text: string) => text.includes(target),
            (text: string) => text.length >= MIN_PARTIAL_CHARS && target.includes(text)
          ]
        : [])
    ]
    for (const matches of stages) {
      const hits = filled.filter((index) => matches(texts[index]))
      if (hits.length > 0) return pick(hits, expected)
    }
  }

  return expected ?? -1
}
