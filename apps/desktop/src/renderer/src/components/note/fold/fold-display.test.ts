import { describe, expect, it } from 'vitest'
import type { FoldSection } from '@memry/contracts/note-fold'
import { layers, paragraph } from './fold-fixtures'
import {
  buildFoldedView,
  chipLabel,
  effectiveLevel,
  isFoldable,
  levelAvailability,
  paragraphLine,
  stepLevel,
  type FoldedItem
} from './fold-display'

const none: ReadonlySet<string> = new Set()

function sections(items: readonly FoldedItem[]) {
  return items.flatMap((item) => (item.kind === 'section' ? [item.section] : []))
}

describe('which notes fold and which levels show', () => {
  it('folds only notes above the length floor', () => {
    expect(isFoldable(null)).toBe(false)
    expect(isFoldable(layers({ status: 'short', totalWords: 90 }))).toBe(false)
    expect(isFoldable(layers({ totalWords: 150 }))).toBe(false)
    expect(isFoldable(layers({ totalWords: 151 }))).toBe(true)
  })

  it('shows Brief in place of a level the model has not written yet', () => {
    const writing = layers({ ready: [], status: 'writing' })
    expect(levelAvailability(writing, 'key')).toBe('writing')
    expect(effectiveLevel('key', writing)).toBe('brief')
    expect(effectiveLevel('full', writing)).toBe('full')
    expect(effectiveLevel('brief', writing)).toBe('brief')
  })

  it('arrives at the requested level once it is written', () => {
    expect(effectiveLevel('topic', layers({ ready: ['topic'], status: 'writing' }))).toBe('topic')
  })

  it('has nothing to wait for with no agent, so written levels are unavailable', () => {
    const noAgent = layers({ ready: [], status: 'no_agent', agent: null })
    expect(levelAvailability(noAgent, 'takeaway')).toBe('unavailable')
    expect(effectiveLevel('takeaway', noAgent)).toBe('brief')
  })

  it('steps through ready levels only and stops at the ends', () => {
    const partial = layers({ ready: ['takeaway'], status: 'writing' })
    expect(stepLevel('full', 1, partial)).toBe('brief')
    expect(stepLevel('brief', 1, partial)).toBe('takeaway')
    expect(stepLevel('takeaway', 1, partial)).toBe('takeaway')
    expect(stepLevel('takeaway', -1, partial)).toBe('brief')
    expect(stepLevel('full', -1, partial)).toBe('full')
  })
})

describe('paragraph lines', () => {
  it('Brief is the author’s own sentences, in order, joined verbatim', () => {
    const line = paragraphLine(paragraph({ hash: 'a', briefIdx: [2, 0] }), 'brief', 'en')
    expect(line).toEqual({
      text: 'First sentence here. Third sentence here.',
      md: 'First sentence here. Third sentence here.',
      source: 'author'
    })
  })

  it('Brief joins CJK sentences without a space', () => {
    const line = paragraphLine(
      paragraph({ hash: 'a', sentences: ['今日は晴れ。', '明日は雨。'], briefIdx: [0, 1] }),
      'brief',
      'ja'
    )
    expect(line.text).toBe('今日は晴れ。明日は雨。')
  })

  it('Brief falls back to the whole paragraph when no sentence was picked', () => {
    const line = paragraphLine(
      paragraph({ hash: 'a', briefIdx: [], text: 'Only text.' }),
      'brief',
      'en'
    )
    expect(line.text).toBe('Only text.')
  })

  it('Key is the written point and its reason', () => {
    const [p1] = layers().sections[0].paragraphs
    expect(paragraphLine(p1, 'key', 'en')).toEqual({
      text: 'The team plan barely sold. Buyers wanted device sync.',
      md: null,
      source: 'written'
    })
  })

  it('a line the model has not written falls back to the author’s Brief', () => {
    const unwritten = paragraph({ hash: 'a', key: null, takeaway: null })
    expect(paragraphLine(unwritten, 'key', 'en').source).toBe('author')
    expect(paragraphLine(unwritten, 'takeaway', 'en').source).toBe('author')
  })

  it('names a chip by its topic, else by the paragraph’s first words', () => {
    expect(chipLabel(paragraph({ hash: 'a', topic: 'Pro at $8' }), 'en')).toBe('Pro at $8')
    expect(chipLabel(paragraph({ hash: 'a', text: 'One two three four five six' }), 'en')).toBe(
      'One two three four…'
    )
    expect(chipLabel(paragraph({ hash: 'a', text: '短い文' }), 'zh')).toBe('短い文')
  })
})

describe('folded view', () => {
  it('lists every section with one line per paragraph and keeps headings', () => {
    const view = buildFoldedView(layers(), 'takeaway', none, none)
    const [first, second] = sections(view.items)
    expect(first.heading).toBe('Where we are')
    expect(first.paragraphs.map((p) => p.line.text)).toEqual([
      'The team plan barely sold',
      'Pro stays at $8'
    ])
    expect(second.heading).toBeNull()
  })

  it('opens only the clicked paragraph to its full text', () => {
    const view = buildFoldedView(layers(), 'takeaway', new Set(['p2']), none)
    const [first] = sections(view.items)
    expect(first.paragraphs.map((p) => p.open)).toEqual([false, true])
    expect(first.paragraphs[1].line.text).toContain('Second sentence here.')
  })

  it('shows Topic as a card per section with a chip per paragraph', () => {
    const view = buildFoldedView(layers(), 'topic', none, none)
    expect(view.items).toHaveLength(2)
    const [first] = view.items
    expect(first).toMatchObject({
      kind: 'card',
      card: {
        heading: 'Where we are',
        takeaway: 'The team plan barely sold, so Pro absorbs it',
        chips: [
          { paragraphHash: 'p1', label: 'team plan sales' },
          { paragraphHash: 'p2', label: 'First sentence here. Second…' }
        ]
      }
    })
  })

  it('gives a headingless note one card', () => {
    const headingless = layers({ sections: [layers().sections[1]] })
    const view = buildFoldedView(headingless, 'topic', none, none)
    expect(view.items).toHaveLength(1)
    expect(view.items[0]).toMatchObject({ kind: 'card', card: { heading: null } })
  })

  it('unfolds one Topic section in full and leaves the rest as cards', () => {
    const view = buildFoldedView(layers(), 'topic', none, new Set(['s1']))
    expect(view.items.map((item) => item.kind)).toEqual(['section', 'card'])
    const [open] = sections(view.items)
    expect(open.unfolded).toBe(true)
    expect(open.paragraphs.every((p) => p.line.text.length > 0 && p.open)).toBe(true)
  })

  it('skips empty paragraphs', () => {
    const base = layers()
    const withEmpty = layers({
      sections: [
        {
          ...base.sections[0],
          paragraphs: [paragraph({ hash: 'e', text: '  ' }), ...base.sections[0].paragraphs]
        }
      ]
    })
    const [section] = sections(buildFoldedView(withEmpty, 'brief', none, none).items)
    expect(section.paragraphs.map((p) => p.hash)).toEqual(['p1', 'p2'])
  })
})

describe('rich Brief', () => {
  it('carries the picked sentences’ inline Markdown, joined like the text', () => {
    const rich = paragraph({
      hash: 'a',
      sentencesMd: ['**First** sentence here.', 'Second sentence here.', 'Third `sentence` here.'],
      briefIdx: [2, 0]
    })
    expect(paragraphLine(rich, 'brief', 'en')).toMatchObject({
      text: 'First sentence here. Third sentence here.',
      md: '**First** sentence here. Third `sentence` here.'
    })
  })

  it('renders plain when the Markdown is not aligned with the sentences', () => {
    const line = paragraphLine(paragraph({ hash: 'a', sentencesMd: ['only one'] }), 'brief', 'en')
    expect(line.md).toBeNull()
  })
})

describe('skipped blocks', () => {
  function withSkipped(
    skipped: FoldSection['skipped'],
    paragraphs = layers().sections[0].paragraphs
  ) {
    return layers({ sections: [{ ...layers().sections[0], skipped, paragraphs }] })
  }

  it('places each marker after its paragraph, or at the section start for -1', () => {
    const note = withSkipped([
      { afterParagraph: -1, kind: 'image', count: 2 },
      { afterParagraph: 0, kind: 'code', count: 1 }
    ])
    const [section] = sections(buildFoldedView(note, 'key', none, none).items)
    expect(section.skippedAtStart).toEqual([{ afterParagraph: -1, kind: 'image', count: 2 }])
    expect(section.paragraphs.map((p) => p.skippedAfter.map((m) => m.kind))).toEqual([['code'], []])
  })

  it('keeps a marker that followed an empty paragraph with the paragraph before it', () => {
    const [p1, p2] = layers().sections[0].paragraphs
    const note = withSkipped(
      [{ afterParagraph: 1, kind: 'table', count: 1 }],
      [p1, paragraph({ hash: 'e', text: ' ' }), p2]
    )
    const [section] = sections(buildFoldedView(note, 'brief', none, none).items)
    expect(section.paragraphs.map((p) => p.skippedAfter.length)).toEqual([1, 0])
  })

  it('shows no markers on a Topic card or an unfolded Topic section', () => {
    const note = withSkipped([{ afterParagraph: 0, kind: 'code', count: 1 }])
    const unfolded = sections(buildFoldedView(note, 'topic', none, new Set(['s1'])).items)[0]
    expect(unfolded.paragraphs.every((p) => p.skippedAfter.length === 0)).toBe(true)
    expect(buildFoldedView(note, 'topic', none, none).items[0].kind).toBe('card')
  })
})
