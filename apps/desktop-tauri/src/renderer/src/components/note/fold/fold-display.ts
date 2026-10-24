import {
  FOLD_LEVELS,
  FOLD_MIN_WORDS,
  type FoldLayers,
  type FoldLevel,
  type FoldParagraph,
  type FoldSection,
  type FoldSkipped
} from '@memry/contracts/note-fold'
import { paragraphTokens, type MorphToken } from './fold-morph'

/**
 * Pure display model for the folded note view. The main-process fold service
 * owns the layers; this turns a snapshot and a level into what the overlay
 * renders. Nothing here touches the editor or the document.
 */

/** Order the levels step in: from every word down to the map. */
export const FOLD_ORDER: readonly FoldLevel[] = FOLD_LEVELS

export type LevelAvailability = 'ready' | 'writing' | 'unavailable'

/** Notes at or under the minimum are never folded; a snapshot says so with status `short`. */
export function isFoldable(layers: FoldLayers | null): layers is FoldLayers {
  return layers !== null && layers.status !== 'short' && layers.totalWords > FOLD_MIN_WORDS
}

/** Full and Brief always exist (Brief falls back to local sentences). The rest wait for the model. */
export function levelAvailability(layers: FoldLayers, level: FoldLevel): LevelAvailability {
  if (level === 'full' || level === 'brief' || layers.ready.includes(level)) return 'ready'
  return layers.status === 'writing' ? 'writing' : 'unavailable'
}

/** A level that is not written yet shows Brief until it arrives. */
export function effectiveLevel(requested: FoldLevel, layers: FoldLayers | null): FoldLevel {
  if (layers === null) return 'full'
  return levelAvailability(layers, requested) === 'ready' ? requested : 'brief'
}

export function levelWordCount(layers: FoldLayers, level: FoldLevel): number {
  return level === 'full' ? layers.totalWords : (layers.wordsByLevel[level] ?? 0)
}

/** Next ready level in `delta` direction (-1 toward Full, 1 toward Topic); stays put at either end. */
export function stepLevel(current: FoldLevel, delta: 1 | -1, layers: FoldLayers): FoldLevel {
  for (let i = FOLD_ORDER.indexOf(current) + delta; i >= 0 && i < FOLD_ORDER.length; i += delta) {
    if (levelAvailability(layers, FOLD_ORDER[i]) === 'ready') return FOLD_ORDER[i]
  }
  return current
}

const CJK_LANGUAGES = new Set(['zh', 'ja', 'ko'])

function isCjk(language: string): boolean {
  return CJK_LANGUAGES.has(language.toLowerCase().split('-')[0])
}

/** Ink: the author's own words, or a line the agent wrote. */
export type LineSource = 'author' | 'written'

export interface FoldLine {
  text: string
  /** Inline Markdown of the same line, for the author's Brief; null when it is plain (written lines, fallbacks). */
  md: string | null
  source: LineSource
}

export interface ParagraphView {
  hash: string
  line: FoldLine
  /** The line as words keyed to the source, for the slide between levels; null when it has no word map. */
  tokens: readonly MorphToken[] | null
  /** Blocks the fold left out right after this paragraph, as a quiet marker. */
  skippedAfter: readonly FoldSkipped[]
  fullText: string
  open: boolean
}

export interface SectionView {
  hash: string
  heading: string | null
  paragraphs: readonly ParagraphView[]
  /** Blocks the fold left out before the first paragraph. */
  skippedAtStart: readonly FoldSkipped[]
  /** Unfolded from its Topic card: every paragraph shows in full. */
  unfolded: boolean
}

export interface TopicChip {
  paragraphHash: string
  label: string
}

export interface TopicCard {
  hash: string
  heading: string | null
  takeaway: string | null
  chips: readonly TopicChip[]
}

export type FoldedItem =
  | { kind: 'section'; section: SectionView }
  | { kind: 'card'; card: TopicCard }

export interface FoldedView {
  level: FoldLevel
  items: readonly FoldedItem[]
}

const joinerFor = (language: string): string => (isCjk(language) ? '' : ' ')

function briefLine(paragraph: FoldParagraph, language: string): FoldLine {
  const indices = [...new Set(paragraph.briefIdx)]
    .filter((index) => index < paragraph.sentences.length)
    .toSorted((a, b) => a - b)
  const joiner = joinerFor(language)
  if (indices.length === 0) {
    return { text: paragraph.text, md: null, source: 'author' }
  }
  // Markdown is aligned 1:1 with the sentences; a snapshot that is not renders plain.
  const aligned = paragraph.sentencesMd.length === paragraph.sentences.length
  return {
    text: indices.map((index) => paragraph.sentences[index]).join(joiner),
    md: aligned ? indices.map((index) => paragraph.sentencesMd[index]).join(joiner) : null,
    source: 'author'
  }
}

/** What one paragraph reads as at a level. A line the model has not written falls back to Brief. */
export function paragraphLine(
  paragraph: FoldParagraph,
  level: FoldLevel,
  language: string
): FoldLine {
  if (level === 'full') return { text: paragraph.text, md: null, source: 'author' }
  if (level === 'key' && paragraph.key) {
    const { takeaway, reason } = paragraph.key
    return {
      text: [takeaway, reason].filter(Boolean).join(joinerFor(language)),
      md: null,
      source: 'written'
    }
  }
  if (level === 'takeaway' && paragraph.takeaway) {
    return { text: paragraph.takeaway, md: null, source: 'written' }
  }
  return briefLine(paragraph, language)
}

const CHIP_WORDS = 4
const CHIP_CJK_CHARS = 8

/** A paragraph's Topic chip: the model's topic, else the paragraph's first words. */
export function chipLabel(paragraph: FoldParagraph, language: string): string {
  if (paragraph.topic) return paragraph.topic
  const text = paragraph.text.trim()
  if (isCjk(language)) {
    // oxlint-disable-next-line typescript/no-misused-spread -- spreads a string into code points on purpose, so surrogate pairs are not split
    const chars = [...text]
    return chars.length > CHIP_CJK_CHARS ? `${chars.slice(0, CHIP_CJK_CHARS).join('')}…` : text
  }
  const words = text.split(/\s+/)
  return words.length > CHIP_WORDS ? `${words.slice(0, CHIP_WORDS).join(' ')}…` : text
}

function sectionTakeaway(section: FoldSection, language: string): string | null {
  if (section.takeaway) return section.takeaway
  const first = section.paragraphs.find((p) => p.text.trim() !== '')
  if (!first) return null
  return (first.takeaway ?? briefLine(first, language).text) || null
}

function sectionView(
  section: FoldSection,
  level: FoldLevel,
  language: string,
  openParagraphs: ReadonlySet<string>,
  unfolded: boolean
): SectionView {
  const showSkipped = !unfolded && level !== 'full' && level !== 'topic'
  const skippedAtStart: FoldSkipped[] = []
  const paragraphs: (ParagraphView & { skippedAfter: FoldSkipped[] })[] = []
  section.paragraphs.forEach((paragraph, index) => {
    if (paragraph.text.trim() !== '') {
      const open = unfolded || openParagraphs.has(paragraph.hash)
      paragraphs.push({
        hash: paragraph.hash,
        line: paragraphLine(paragraph, open ? 'full' : level, language),
        tokens: open ? null : paragraphTokens(paragraph, level, joinerFor(language)),
        skippedAfter: [],
        fullText: paragraph.text,
        open
      })
    }
    if (!showSkipped) return
    // A marker that follows a skipped empty paragraph stays with the one before it.
    const last = index === section.paragraphs.length - 1
    for (const marker of section.skipped) {
      if (marker.afterParagraph !== index && !(last && marker.afterParagraph > index)) continue
      const host =
        paragraphs.length > 0 ? paragraphs[paragraphs.length - 1].skippedAfter : skippedAtStart
      host.push(marker)
    }
  })
  if (showSkipped) {
    const start = section.skipped.filter((marker) => marker.afterParagraph < 0)
    skippedAtStart.unshift(...start)
    if (section.paragraphs.length === 0) {
      skippedAtStart.push(...section.skipped.filter((marker) => marker.afterParagraph >= 0))
    }
  }
  return { hash: section.hash, heading: section.heading, unfolded, skippedAtStart, paragraphs }
}

/**
 * The folded view for a level. Topic renders a card per section, except a
 * section the reader unfolded, which reads in full in place. Other levels
 * render every section with a line per paragraph, and a paragraph the reader
 * opened shows its full text.
 */
export function buildFoldedView(
  layers: FoldLayers,
  level: FoldLevel,
  openParagraphs: ReadonlySet<string>,
  unfoldedSections: ReadonlySet<string>
): FoldedView {
  const { language, sections } = layers
  const items = sections.map((section): FoldedItem => {
    if (level === 'topic' && !unfoldedSections.has(section.hash)) {
      return {
        kind: 'card',
        card: {
          hash: section.hash,
          heading: section.heading,
          takeaway: sectionTakeaway(section, language),
          chips: section.paragraphs
            .filter((paragraph) => paragraph.text.trim() !== '')
            .map((paragraph) => ({
              paragraphHash: paragraph.hash,
              label: chipLabel(paragraph, language)
            }))
        }
      }
    }
    return {
      kind: 'section',
      section: sectionView(section, level, language, openParagraphs, level === 'topic')
    }
  })
  return { level, items }
}

/** The source paragraph behind a hash, for putting the caret back on it. */
export function findParagraph(layers: FoldLayers, hash: string): FoldParagraph | null {
  for (const section of layers.sections) {
    const found = section.paragraphs.find((paragraph) => paragraph.hash === hash)
    if (found) return found
  }
  return null
}
