import { describe, expect, it } from 'vitest'
import { dropStaleMaskTokens, withoutStaleMaskTokens } from './stale-mask-tokens'

const WORD = 'ZYXWVUTSRQPO'

describe('dropStaleMaskTokens', () => {
  it('drops each form of token, whatever its word', () => {
    for (const token of [
      `MEMRYHBK${WORD}0;`,
      `MEMRYHBK${WORD}123456;`,
      `MEMRYCSP${WORD}7X`,
      `MEMRYCSP${WORD}SX`,
      `MEMRYCSP${WORD}TX`,
      `MEMRYTKN${WORD}0X`,
      `MEMRYTKN${WORD}283a28X`,
      `MEMRYICO${WORD}4:`,
      `:MEMRYICC${WORD};`,
      `MEMRYEMO${WORD}1;`,
      `MEMRYEMC${WORD}1;`,
      `MEMRYEMK${WORD}1;`,
      `MEMRYEMU${WORD}1;`,
      `MEMRYLNK${WORD}2X`,
      `MEMRYCMT${WORD}X`,
      `MEMRYCMT${WORD}3c21X`,
      `MEMRYEMB${WORD}`
    ]) {
      expect(dropStaleMaskTokens(`a${token}b`)).toBe('ab')
      expect(dropStaleMaskTokens(`${token}${token}`)).toBe('')
    }
  })

  it('puts back the < a hidden details tag stood for', () => {
    expect(dropStaleMaskTokens(`MEMRYDLT${WORD};summary>x`)).toBe('<summary>x')
  })

  it('keeps the colon of a colour end only when the token has it', () => {
    expect(dropStaleMaskTokens(`a:MEMRYICC${WORD};b`)).toBe('ab')
    expect(dropStaleMaskTokens(`MEMRYICC${WORD};b`)).toBe('b')
  })

  it('leaves text that is not a token', () => {
    for (const text of [
      '',
      'MEMRY',
      'MEMRYHBK0;',
      'MEMRYHBK',
      'MEMRYHBKabc0;',
      `MEMRYHBK${WORD}`,
      `MEMRYHBK${WORD};`,
      `MEMRYHBK${WORD.slice(1)}0;`,
      `MEMRYHBK${WORD.toLowerCase()}0;`,
      `MEMRYXYZ${WORD}0;`,
      `MEMRYCMT${WORD}ZX`,
      `MEMRYCSP${WORD}0`,
      'MEMRYHBK MEMRYEMB'
    ]) {
      expect(dropStaleMaskTokens(text)).toBe(text)
    }
  })

  it('reads a token that follows an unfinished one', () => {
    expect(dropStaleMaskTokens(`MEMRYHBK${WORD}9MEMRYHBK${WORD}0;`)).toBe(`MEMRYHBK${WORD}9`)
  })

  it('reads a long run in linear time', () => {
    const digits = `MEMRYHBK${WORD}${'1'.repeat(200_000)}`
    const started = performance.now()
    expect(dropStaleMaskTokens(digits.repeat(20))).toBe(digits.repeat(20))
    expect(dropStaleMaskTokens(`MEMRY`.repeat(200_000))).toBe(`MEMRY`.repeat(200_000))
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('withoutStaleMaskTokens', () => {
  it('drops tokens from every string, keys aside', () => {
    const token = `MEMRYHBK${WORD}0;`
    const blocks = [
      {
        type: 'paragraph',
        props: { alt: `a${token}` },
        content: [
          { type: 'text', text: `x${token}`, styles: { bold: true } },
          { type: 'link', href: `u${token}v`, content: [{ type: 'text', text: 'l', styles: {} }] }
        ],
        children: []
      }
    ]
    expect(withoutStaleMaskTokens(blocks)).toEqual([
      {
        type: 'paragraph',
        props: { alt: 'a' },
        content: [
          { type: 'text', text: 'x', styles: { bold: true } },
          { type: 'link', href: 'uv', content: [{ type: 'text', text: 'l', styles: {} }] }
        ],
        children: []
      }
    ])
  })

  it('returns a value with no token as it is, part by part', () => {
    const kept = { type: 'text', text: 'a', styles: {} }
    const blocks = [{ content: [kept], props: { n: 1, ok: true, none: null } }]
    expect(withoutStaleMaskTokens(blocks)).toBe(blocks)
    const mixed = [{ content: [kept] }, { content: [{ text: `MEMRYEMB${WORD}` }] }]
    const out = withoutStaleMaskTokens(mixed)
    expect(out).not.toBe(mixed)
    expect(out[0]).toBe(mixed[0])
    expect(out[1]).toEqual({ content: [{ text: '' }] })
  })
})
