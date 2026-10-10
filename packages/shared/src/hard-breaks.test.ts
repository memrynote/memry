import { describe, expect, it } from 'vitest'
import { maskHardBreaks, restoreHardBreakSpelling, unmaskHardBreaks } from './hard-breaks'

describe('hard break masking', () => {
  it('leaves a <br> inside link or image text unmarked, since that text is never unmasked', () => {
    for (const md of [
      '[a<br>b](u)',
      '![x<br>y](i.png)',
      'see [a<br>b](u) now',
      'a] [b<br>c](u)',
      '[a\nb<br>c](u)',
      'a [b](u<br>c)',
      '![i](p.png<br>x)',
      '<a href="u">a<br>b</a>'
    ]) {
      expect(maskHardBreaks(md)).toEqual({ markdown: md, breaks: [] })
    }
  })

  it('marks a two-space hard break and leaves a soft break alone', () => {
    // #given 0.51's parser maps both spellings onto one newline, so the hard
    // one has to be marked before it reaches the parser.
    const { markdown: masked, breaks } = maskHardBreaks('One  \nTwo\nThree')

    // #then the hard break carries a token and the soft one does not
    expect(masked).not.toContain('  \n')
    expect(masked.split('\n')[0]).toMatch(/One\w+;$/)
    expect(masked.split('\n')[1]).toBe('Two')
    // #and the spelling it replaced travelled with it
    expect(breaks).toEqual(['  '])
  })

  it('marks a backslash hard break too, and remembers it was a backslash', () => {
    const { markdown: masked, breaks } = maskHardBreaks('One\\\nTwo')

    expect(masked).not.toContain('\\\n')
    expect(breaks).toEqual(['\\'])
  })

  it('leaves a line whose trailing spaces end the paragraph', () => {
    // #given nothing follows, so the parser produces no break at all
    expect(maskHardBreaks('One  \n\nTwo')).toEqual({ markdown: 'One  \n\nTwo', breaks: [] })
  })

  it('leaves two trailing spaces inside a fence as content', () => {
    const md = '```sh\nline one  \nline two\n```'
    expect(maskHardBreaks(md)).toEqual({ markdown: md, breaks: [] })
  })

  it('round-trips a hard break into the two newlines the doc spells it with', () => {
    // #given the document holds a soft break as one newline and a hard break
    // as two; `normalizeSerializedMarkdown` reads that back on the way out.
    const { markdown: masked } = maskHardBreaks('One  \nTwo')
    const parsed = unmaskHardBreaks(masked)

    expect(parsed).toBe('One\n\nTwo')
  })

  it('deletes a token that lost its newline rather than leaking it', () => {
    // #given the fallback that makes this safe: the worst case is a hard break
    // that stays soft, never a token written into the user's file.
    const { markdown: masked } = maskHardBreaks('One  \nTwo')
    const token = masked.split('\n')[0].replace('One', '')

    expect(unmaskHardBreaks(`One${token}Two`)).toBe('OneTwo')
  })

  it('gives a code block back the spelling, not the break', () => {
    // #given a run that became a code block \u2014 BlockNote maps a raw `<pre>`
    // onto one, and `<pre>` is prose as far as the mask is concerned. Its
    // bytes are literal, so a trailing backslash there is a shell line
    // continuation and not a paragraph break.
    const { markdown: masked, breaks } = maskHardBreaks('npm run build \\\n  --silent')

    // #then
    expect(restoreHardBreakSpelling(masked, breaks)).toBe('npm run build \\\n  --silent')
  })

  it('deletes a code-block token whose spelling was never recorded', () => {
    // #given the same safety property as `unmaskHardBreaks`: the one thing
    // that must never reach the user's file is the token.
    expect(restoreHardBreakSpelling('one MEMRYHBK9; two', [])).toBe('one  two')
  })

  it('never carries a list item join across a code span, link or tag', () => {
    // #given a `<br>` joined into these would be written into the file as text
    for (const md of ['- `a  \n  b` x', '- [a  \n  b](u)', '- a  \n  b <br> c']) {
      // #then
      expect(maskHardBreaks(md).markdown).not.toContain('<br>' + md.split('\n')[1].trimStart())
    }
  })
})
