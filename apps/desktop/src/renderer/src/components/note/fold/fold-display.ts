import {
  FOLD_LEVELS,
  FOLD_MIN_WORDS,
  type FoldLayers,
  type FoldLevel,
  type FoldParagraph,
  type FoldSection
} from '@memry/contracts/note-fold'

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
  source: LineSource
  /** Sentence indices a written line rests on; empty for the author's own words. */
  evidence: readonly number[]
}

export interface ParagraphView {
  hash: string
  line: FoldLine
  /** Source sentences, for the evidence popover. */
  sentences: readonly string[]
  fullText: string
  open: boolean
}

export interface SectionView {
  hash: string
  heading: string | null
  paragraphs: readonly ParagraphView[]
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
  { kind: 'section'; section: SectionView } | { kind: 'card'; card: TopicCard }

export interface FoldedView {
  level: FoldLevel
  items: readonly FoldedItem[]
  sectionCount: number
}

function briefLine(paragraph: FoldParagraph, language: string): FoldLine {
  const picked = [...new Set(paragraph.briefIdx)]
    .sort((a, b) => a - b)
    .flatMap((index) => paragraph.sentences[index] ?? [])
  const text = picked.length > 0 ? picked.join(isCjk(language) ? '' : ' ') : paragraph.text
  return { text, source: 'author', evidence: [] }
}

/** What one paragraph reads as at a level. A line the model has not written falls back to Brief. */
export function paragraphLine(
  paragraph: FoldParagraph,
  level: FoldLevel,
  language: string
): FoldLine {
  if (level === 'full') return { text: paragraph.text, source: 'author', evidence: [] }
  if (level === 'key' && paragraph.key) {
    const { takeaway, reason } = paragraph.key
    const joiner = isCjk(language) ? '' : ' '
    return {
      text: [takeaway, reason].filter(Boolean).join(joiner),
      source: 'written',
      evidence: paragraph.evidence
    }
  }
  if (level === 'takeaway' && paragraph.takeaway) {
    return { text: paragraph.takeaway, source: 'written', evidence: paragraph.evidence }
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
  return {
    hash: section.hash,
    heading: section.heading,
    unfolded,
    paragraphs: section.paragraphs
      .filter((paragraph) => paragraph.text.trim() !== '')
      .map((paragraph) => {
        const open = unfolded || openParagraphs.has(paragraph.hash)
        return {
          hash: paragraph.hash,
          line: paragraphLine(paragraph, open ? 'full' : level, language),
          sentences: paragraph.sentences,
          fullText: paragraph.text,
          open
        }
      })
  }
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
  return { level, items, sectionCount: sections.length }
}

export interface EvidenceSegment {
  text: string
  cited: boolean
}

/** Source sentences of a paragraph, marking the ones a written line rests on. Out-of-range indices are ignored. */
export function evidenceSegments(
  sentences: readonly string[],
  evidence: readonly number[]
): EvidenceSegment[] {
  const cited = new Set(evidence)
  return sentences.map((text, index) => ({ text, cited: cited.has(index) }))
}

/** The source paragraph behind a hash, for putting the caret back on it. */
export function findParagraph(layers: FoldLayers, hash: string): FoldParagraph | null {
  for (const section of layers.sections) {
    const found = section.paragraphs.find((paragraph) => paragraph.hash === hash)
    if (found) return found
  }
  return null
}
