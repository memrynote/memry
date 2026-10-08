import { describe, expect, it } from 'vitest'
import {
  decodeHtmlCommentTokens,
  encodeHtmlCommentToken,
  maskHtmlComments,
  splitHtmlCommentTokens
} from './html-comments'

describe('html comment tokens (AF-015)', () => {
  it('round-trips any comment through a token', () => {
    const source = '<!--\nmulti line [[Ünïcode]] `tick` *star* \\ |\n\n-->'
    const token = encodeHtmlCommentToken(source)
    expect(token).toMatch(/^[A-Za-z0-9]+$/)
    expect(decodeHtmlCommentTokens(`a ${token} b`)).toBe(`a ${source} b`)
  })

  it('splits text around its tokens', () => {
    const token = encodeHtmlCommentToken('<!-- c -->')
    expect(splitHtmlCommentTokens(`a ${token}${token}`)).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'comment', source: '<!-- c -->' },
      { kind: 'comment', source: '<!-- c -->' }
    ])
    expect(splitHtmlCommentTokens('plain')).toEqual([{ kind: 'text', text: 'plain' }])
  })

  it('leaves note text that looks like a token alone (BBF-30)', () => {
    const literal = [
      'Literal MEMRYCMTX and MEMRYCMT3c212d2d2d3eX here.',
      'Code `MEMRYCMT41X` span.',
      '```',
      'MEMRYCMT42X',
      '```'
    ].join('\n')
    const masked = maskHtmlComments(`${literal}\n<!-- c -->`)
    expect(decodeHtmlCommentTokens(masked)).toBe(`${literal}\n<!-- c -->`)
    expect(splitHtmlCommentTokens(literal)).toEqual([{ kind: 'text', text: literal }])
    expect(decodeHtmlCommentTokens(`${literal} ${encodeHtmlCommentToken('<!-- c -->')}`)).toBe(
      `${literal} <!-- c -->`
    )
  })
})

describe('maskHtmlComments (AF-015)', () => {
  const masked = (markdown: string): string => maskHtmlComments(markdown)
  const roundTrip = (markdown: string): string => decodeHtmlCommentTokens(masked(markdown))

  it('masks inline, whole-line and multi-line comments, blank lines included', () => {
    const markdown = [
      '<!-- above [[A]] -->',
      '# Heading',
      'Text <!-- inline --> more.',
      '<!--',
      '## Draft',
      '',
      '```js',
      'x',
      '```',
      '-->',
      'Tail'
    ].join('\n')
    const out = masked(markdown)
    expect(out).not.toContain('<!--')
    expect(out.split('\n')).toHaveLength(5)
    expect(roundTrip(markdown)).toBe(markdown)
  })

  it('leaves comments in code fences and code spans alone', () => {
    const markdown = ['`<!-- span -->`', '```', '<!-- fenced -->', '```', '``a <!-- b ``'].join(
      '\n'
    )
    expect(masked(markdown)).toBe(markdown)
  })

  it('leaves an unterminated comment alone', () => {
    expect(masked('a <!-- never closed\nb')).toBe('a <!-- never closed\nb')
  })

  it('leaves Memry marker lines alone', () => {
    const markers = [
      '<!-- file:{"url":"a.pdf","name":"a.pdf"} -->',
      '<!-- colors:{"textColor":"red"} -->',
      '<!-- table-colors:{"0:0":{"textColor":"red"}} -->',
      '<!-- align:center -->',
      '<!-- table-layout:{"columnWidths":[120,null]} -->',
      '<!-- memry:block-nesting-level=1 -->',
      'a <!--alt:k1-->b<!--/alt--> <!--ghost-->c<!--/ghost-->'
    ].join('\n')
    expect(masked(markers)).toBe(markers)
  })

  it('masks a comment that only looks like a marker when it is not on its own line', () => {
    expect(masked('Text <!-- align:center -->')).not.toContain('<!--')
  })
})

describe('maskHtmlComments with %% comments (BBF-26)', () => {
  const note =
    'Tail text %% [[Topic]] secret %% end of line.\n\n%%\nblock [[Other]] secret\n%%\n\nAfter'

  it.each([
    ['LF', note],
    ['CRLF', note.replaceAll('\n', '\r\n')]
  ])('masks inline and block Obsidian comments on a %s note', (_label, markdown) => {
    const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
    const out = maskHtmlComments(markdown)
    expect(out).not.toContain('%%')
    expect(out).not.toContain('[[')
    expect(splitHtmlCommentTokens(out.split(eol)[0])).toEqual([
      { kind: 'text', text: 'Tail text ' },
      { kind: 'comment', source: '%% [[Topic]] secret %%' },
      { kind: 'text', text: ' end of line.' }
    ])
    expect(splitHtmlCommentTokens(out.split(eol)[2])).toEqual([
      { kind: 'comment', source: ['%%', 'block [[Other]] secret', '%%'].join(eol) }
    ])
    expect(decodeHtmlCommentTokens(out)).toBe(markdown)
  })

  it('leaves a %% in code and a %% with no partner as text', () => {
    const markdown = [
      'Sale 50%% off',
      '`%% x %%`',
      '```bat',
      'for %%i in (*) do echo %%i',
      '```'
    ].join('\n')
    expect(maskHtmlComments(markdown)).toBe(markdown)
  })
})
