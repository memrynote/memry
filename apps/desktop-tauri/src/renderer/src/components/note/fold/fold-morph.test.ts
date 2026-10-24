import { describe, expect, it } from 'vitest'
import { layers, paragraph } from './fold-fixtures'
import {
  chunkTokens,
  MORPH_TOKEN_CAP,
  paragraphTokens,
  planMorph,
  type MorphToken
} from './fold-morph'

const word = (text: string, src: number | null): MorphToken => ({ text, src })
const space: MorphToken = { text: ' ', src: null }

describe('planMorph', () => {
  it('slides words both lines share, fades in new ones, fades out dropped ones', () => {
    const from = [word('Pro', 0), space, word('stays', 2), space, word('cheap', 4)]
    const to = [word('Pro', 0), space, word('sells', null), space, word('cheap', 4)]
    expect(planMorph(from, to)).toEqual({
      mode: 'morph',
      incoming: [
        { kind: 'slide', from: 0 },
        { kind: 'still' },
        { kind: 'in' },
        { kind: 'still' },
        { kind: 'slide', from: 4 }
      ],
      outgoing: ['matched', 'still', 'out', 'still', 'matched']
    })
  })

  it('matches by source index, not by text', () => {
    const plan = planMorph([word('plan', 6)], [word('Plan', 6)])
    expect(plan.incoming).toEqual([{ kind: 'slide', from: 0 }])
  })

  it('uses each outgoing word once', () => {
    const plan = planMorph([word('a', 1), word('b', 3)], [word('a', 1), word('a', 1)])
    expect(plan.incoming).toEqual([{ kind: 'slide', from: 0 }, { kind: 'in' }])
    expect(plan.outgoing).toEqual(['matched', 'out'])
  })

  it('does nothing for lines that read the same', () => {
    const line = [word('Same', 0), space, word('line', 2)]
    expect(planMorph(line, [...line]).mode).toBe('none')
  })

  it('crossfades when a line has no word map', () => {
    expect(planMorph(null, [word('a', 0)]).mode).toBe('crossfade')
    expect(planMorph([word('a', 0)], null).mode).toBe('crossfade')
  })

  it('crossfades when the lines share no word', () => {
    expect(planMorph([word('one', 0)], [word('two', null)]).mode).toBe('crossfade')
  })

  it('crossfades above the token cap', () => {
    const big = Array.from({ length: MORPH_TOKEN_CAP }, (_, i) => word(`w${i}`, i))
    expect(planMorph(big, [word('w0', 0), word('x', null)]).mode).toBe('crossfade')
    expect(
      planMorph(big.slice(0, MORPH_TOKEN_CAP - 2), [word('w0', 0), word('x', null)]).mode
    ).toBe('morph')
  })
})

describe('chunkTokens', () => {
  it('keeps a word with the punctuation stuck to it and drops whitespace', () => {
    const tokens = [word('Hi', 0), word(',', 1), space, word('"', 3), word('you', 4), word('!', 5)]
    expect(chunkTokens(tokens)).toEqual([
      [0, 1],
      [3, 4, 5]
    ])
  })

  it('lets adjacent words break apart, as in CJK', () => {
    expect(chunkTokens([word('今日', 0), word('は', 1), word('晴れ', 2)])).toEqual([[0], [1], [2]])
  })
})

describe('paragraphTokens', () => {
  const text = 'Pro stays at eight dollars. The team plan barely sold. Buyers wanted device sync.'
  const base = paragraph({
    hash: 'a',
    text,
    sentences: [
      'Pro stays at eight dollars.',
      'The team plan barely sold.',
      'Buyers wanted device sync.'
    ],
    briefIdx: [2, 0],
    key: { takeaway: 'The team plan barely sold.', reason: 'Buyers wanted device sync.' },
    takeaway: 'The plan barely sold'
  })
  const join = (tokens: MorphToken[] | null) => tokens?.map((t) => t.text).join('')

  it('Brief is the picked source sentences in order, pointing into the source', () => {
    const tokens = paragraphTokens(base, 'brief', ' ')
    expect(join(tokens)).toBe('Pro stays at eight dollars. Buyers wanted device sync.')
    expect(tokens?.[0]).toEqual({ text: 'Pro', src: 0 })
    expect(
      tokens?.filter((t) => t.src !== null).every((t) => base.srcTokens[t.src!] === t.text)
    ).toBe(true)
  })

  it('Brief falls back to the whole paragraph when nothing was picked', () => {
    expect(join(paragraphTokens({ ...base, briefIdx: [] }, 'brief', ' '))).toBe(text)
  })

  it('Key joins the point and its reason; Takeaway is its own map', () => {
    expect(join(paragraphTokens(base, 'key', ' '))).toBe(
      'The team plan barely sold. Buyers wanted device sync.'
    )
    expect(join(paragraphTokens(base, 'takeaway', ' '))).toBe('The plan barely sold')
  })

  it('has no tokens for a written line whose word map is missing', () => {
    const unmapped = { ...base, morph: { ...base.morph, takeaway: null, keyReason: null } }
    expect(paragraphTokens(unmapped, 'takeaway', ' ')).toBeNull()
    expect(paragraphTokens(unmapped, 'key', ' ')).toBeNull()
  })

  it('shows Brief tokens at a level the model has not written', () => {
    const unwritten = paragraph({ hash: 'b', text, sentences: base.sentences })
    expect(paragraphTokens(unwritten, 'key', ' ')).toEqual(paragraphTokens(unwritten, 'brief', ' '))
  })

  it('Key to Takeaway slides the words the takeaway reuses from the source', () => {
    const plan = planMorph(
      paragraphTokens(base, 'key', ' '),
      paragraphTokens(base, 'takeaway', ' ')
    )
    expect(plan.mode).toBe('morph')
    expect(plan.incoming.some((m) => m.kind === 'slide')).toBe(true)
  })

  it('fixture layers carry a word map for every written line', () => {
    const [p1] = layers().sections[0].paragraphs
    expect(p1.morph.keyTakeaway).not.toBeNull()
    expect(p1.morph.topic).not.toBeNull()
  })
})
