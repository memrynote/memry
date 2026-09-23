import { describe, expect, it } from 'vitest'
import { maskInlineTokens, restoreInlineTokens } from './token-masking'

describe('maskInlineTokens', () => {
  it('carries a token with underscores across the parse unchanged', () => {
    // #given the regression this exists for: BlockNote 0.51's parser applies
    // `_…_` emphasis inside a word, which CommonMark forbids, and rewrote a
    // Wikipedia URL's underscores as asterisks in the vault file.
    const token =
      '((mention:https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FRust_%28programming_language%29))'
    const source = `A parenthesised article ${token} survives.`

    // #when
    const { markdown, tokens } = maskInlineTokens(source)

    // #then nothing emphasis-shaped is left for the parser to find...
    expect(markdown).not.toContain('_')
    expect(tokens).toEqual([token])
    // ...and the bytes come back exactly
    expect(restoreInlineTokens(markdown, tokens)).toBe(source)
  })

  it('masks date tokens too', () => {
    const source = 'due ((date:eyJhbmNob3JJZCI6ImRtXzAifQ)) ok'
    const { markdown, tokens } = maskInlineTokens(source)

    expect(tokens).toHaveLength(1)
    expect(restoreInlineTokens(markdown, tokens)).toBe(source)
  })

  it('keeps several tokens in order', () => {
    const source = '((mention:a)) then ((date:b)) then ((mention:c))'
    const { markdown, tokens } = maskInlineTokens(source)

    expect(tokens).toEqual(['((mention:a))', '((date:b))', '((mention:c))'])
    expect(restoreInlineTokens(markdown, tokens)).toBe(source)
  })

  it('heals a stray backslash escape rather than carrying it forever', () => {
    // #given the round trip used to fix a token some older build escaped,
    // because the parser ate the backslash. Masking would otherwise preserve
    // the damage for good.
    const { tokens } = maskInlineTokens('due ((date:eyJhbmNob3JJZCI6ImRtXzA\\_eCJ9)) ok')

    expect(tokens).toEqual(['((date:eyJhbmNob3JJZCI6ImRtXzA_eCJ9))'])
  })

  it('leaves a token inside a code fence alone', () => {
    const source = '```\n((mention:https%3A%2F%2Fa_b))\n```'
    const { markdown, tokens } = maskInlineTokens(source)

    expect(tokens).toEqual([])
    expect(markdown).toBe(source)
  })

  it('leaves text with no token untouched', () => {
    const { markdown, tokens } = maskInlineTokens('Just ordinary (parenthesised) prose.')

    expect(tokens).toEqual([])
    expect(markdown).toBe('Just ordinary (parenthesised) prose.')
  })

  it('leaves a placeholder it has no token for as it is', () => {
    // #given text that merely looks like a placeholder is the author's own
    // bytes, so it is left rather than deleted.
    expect(restoreInlineTokens('MEMRYTKN9X', ['((mention:a))'])).toBe('MEMRYTKN9X')
  })
})
