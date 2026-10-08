import { describe, expect, it } from 'vitest'
import { blankMarkdownCode, stripMarkdownComments } from './markdown-code'

describe('blankMarkdownCode', () => {
  it('keeps a %% comment as written, a backtick inside it included', () => {
    const content = [
      'Text %% [[Inline]] ` %% and `[[Code]]`',
      '%%',
      '[[Block]] with a ` tick',
      '%%',
      'After ` stray'
    ].join('\n')
    const out = blankMarkdownCode(content)
    expect(out).toContain('%% [[Inline]] ` %%')
    expect(out).not.toContain('[[Code]]')
    expect(out).toContain('[[Block]] with a ` tick')
  })

  it('reads an unclosed %% as text', () => {
    expect(blankMarkdownCode('50%% off `[[Code]]`')).not.toContain('[[Code]]')
  })
})

describe('stripMarkdownComments', () => {
  it('removes HTML and %% comments outside code', () => {
    const content = [
      '<!-- hidden [[Alpha]] -->',
      '# Title',
      'Inline <!-- [[Beta]] --> and %% [[Gamma]] %% text.',
      '<!--',
      'multi [[Delta]]',
      '-->',
      '%%',
      'block [[Eta]]',
      '%%',
      'End'
    ].join('\n')
    const out = stripMarkdownComments(content)
    for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Eta']) expect(out).not.toContain(name)
    expect(out).not.toContain('<!--')
    expect(out).not.toContain('%%')
    expect(out).toContain('# Title')
    expect(out).toContain('Inline  and  text.')
    expect(out).toContain('End')
  })

  it('keeps comment syntax inside code', () => {
    const content = [
      'Use `<!-- x -->` or `%% y %%`.',
      '```html',
      '<!-- in fence -->',
      '%% z %%',
      '```'
    ].join('\n')
    expect(stripMarkdownComments(content)).toBe(content)
  })

  it('keeps an unclosed %% and an unclosed <!-- as text', () => {
    expect(stripMarkdownComments('50%% off')).toBe('50%% off')
    expect(stripMarkdownComments('a <!-- b')).toBe('a <!-- b')
  })

  it('works on CRLF notes', () => {
    expect(stripMarkdownComments('A\r\n%%\r\n[[X]]\r\n%%\r\nB')).toBe('A\r\n\r\nB')
  })
})
