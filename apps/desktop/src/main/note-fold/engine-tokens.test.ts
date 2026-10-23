import { describe, expect, it } from 'vitest'

import { buildSections } from './engine'
import { expandInlineTokens, withoutInlineTokens } from './engine-tokens'

// The date pill from the Aurora product brief: 2026-11-27, no time.
const DATE_TOKEN =
  '((date:eyJhbmNob3JJZCI6ImRtX2F1cm9yYS1icmllZl8xIiwiZGF0ZUlTTyI6IjIwMjYtMTEtMjciLCJoYXNUaW1lIjpmYWxzZSwiZGF0ZUZvcm1hdCI6ImZ1bGwiLCJyZW1pbmQiOiJub25lIiwidGltZUZvcm1hdCI6InN5c3RlbSJ9))'

describe('inline tokens in a folded note', () => {
  it('turns a date pill into its date, so the base64 never reaches a paragraph', () => {
    const note = `## Scope\n\nLaunch is planned for ${DATE_TOKEN}. The plan is on the canvas.`
    const text = expandInlineTokens(note, 'en')
    expect(text).toContain('Launch is planned for November 27, 2026.')
    expect(text).not.toContain('((date:')

    const paragraph = buildSections(text, 'en')[0].chunks[0].paragraphs[0]
    expect(paragraph.text).toBe(
      'Launch is planned for November 27, 2026. The plan is on the canvas.'
    )
  })

  it('writes the date in the note language', () => {
    expect(expandInlineTokens(`締め切りは ${DATE_TOKEN}`, 'ja')).toContain('2026年11月27日')
  })

  it('shows a link mention as its host and drops a token it cannot decode', () => {
    const mention = `((mention:${encodeURIComponent('https://en.wikipedia.org/wiki/Rust')}))`
    expect(expandInlineTokens(`See ${mention} and ((date:abc)).`, 'en')).toBe(
      'See en.wikipedia.org and .'
    )
  })

  it('keeps token payloads out of language detection input', () => {
    expect(withoutInlineTokens(`a ${DATE_TOKEN} b`)).toBe('a   b')
  })
})
