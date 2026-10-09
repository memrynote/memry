import { describe, expect, it } from 'vitest'
import { blankMarkdownCode, stripMarkdownComments } from './markdown-code'

const strayThenFence = [
  'Sale 50%% off [[Before]]',
  '',
  '```bat',
  'for %%i in (*) do echo %%i',
  '```',
  '',
  'After [[After]] and `[[Code]]`'
].join('\n')

const strayThenSpan = 'Sale 50%% off\nsee `%%d` format [[After]]'

const twoPercents = 'A 50%% sale\n\nmiddle paragraph [[Mid]]\n\nB 20%% tax'

const blockAroundFence = [
  'A',
  '%%',
  '```',
  'x %% y `z`',
  '```',
  'see `%%` [[Hidden]]',
  '%%',
  'B `[[Code]]`'
].join('\n')

describe('a %% on a later line inside code', () => {
  it('does not pair with a stray %% before a fenced block', () => {
    expect(blankMarkdownCode(strayThenFence)).toBe(
      'Sale 50%% off [[Before]]\n\n\n\n\n\nAfter [[After]] and  '
    )
    expect(stripMarkdownComments(strayThenFence)).toBe(strayThenFence)
  })

  it('does not pair with a stray %% before a code span', () => {
    expect(blankMarkdownCode(strayThenSpan)).toBe('Sale 50%% off\nsee   format [[After]]')
    expect(stripMarkdownComments(strayThenSpan)).toBe(strayThenSpan)
  })

  it('does not close a block comment that holds code', () => {
    expect(blankMarkdownCode(blockAroundFence)).toBe(
      'A\n%%\n```\nx %% y `z`\n```\nsee `%%` [[Hidden]]\n%%\nB  '
    )
    expect(stripMarkdownComments(blockAroundFence)).toBe('A\n\nB `[[Code]]`')
  })

  it('leaves two prose %% a comment across paragraphs', () => {
    expect(blankMarkdownCode(twoPercents)).toBe(twoPercents)
    expect(stripMarkdownComments(twoPercents)).toBe('A 50 tax')
  })
})

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

  it('closes a %% comment on a later %% on its opening line, inside inline code too', () => {
    const line = 'Sale 50%% off, format `%%d` [[X]] `[[Code]]`'
    expect(stripMarkdownComments(line)).toBe('Sale 50d` [[X]] `[[Code]]`')
    const out = blankMarkdownCode(line)
    expect(out).toContain('%% off, format `%%')
    expect(out).not.toContain('[[X]]')
    expect(out).toContain('[[Code]]')
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
