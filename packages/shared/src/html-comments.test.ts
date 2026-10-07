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
    expect(out.split('\n')).toHaveLength(4)
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
