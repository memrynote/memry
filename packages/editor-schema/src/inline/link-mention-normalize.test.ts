import { describe, expect, it } from 'vitest'

import type { Block } from '@blocknote/core'
import { normalizeLinkMentions, splitTextWithLinkMentions } from './link-mention-normalize'
import { createLinkMentionContent, serializeLinkMentionToken } from './link-mention'

const url = 'https://eksisozluk.com/entry/184233570?debe=true'
const token = serializeLinkMentionToken(url)

describe('splitTextWithLinkMentions', () => {
  it('splits text around a mention token and preserves surrounding text', () => {
    const { segments, didChange } = splitTextWithLinkMentions(`before ${token} after`)
    expect(didChange).toBe(true)
    expect(segments).toEqual([
      'before ',
      {
        type: 'linkMention',
        props: { url, domain: 'eksisozluk.com', title: '', favicon: '', siteName: '' }
      },
      ' after'
    ])
  })

  it('keeps a token in a styled run as text (#4652)', () => {
    const styled: Array<Record<string, boolean | string>> = [
      { code: true },
      { italic: true },
      { bold: true },
      { underline: true },
      { textColor: 'red' },
      { backgroundColor: 'yellow' }
    ]
    for (const styles of styled) {
      const { segments, didChange } = splitTextWithLinkMentions(`a ${token}`, styles)
      expect(didChange).toBe(false)
      expect(segments).toEqual([{ type: 'text', text: `a ${token}`, styles }])
    }
  })

  it('promotes a token in a run with only inactive styles', () => {
    const styles = { bold: false, textColor: 'default' }
    const { segments, didChange } = splitTextWithLinkMentions(`a ${token}`, styles)
    expect(didChange).toBe(true)
    expect(segments[0]).toEqual({ type: 'text', text: 'a ', styles })
  })

  // Protocol 12.1.1.1's host rule, no IDNA (#4685): `new URL` and the Rust
  // `idna` crate disagreed on every RTL row, so the two seeds diverged.
  const hostRows: Array<[string, string | null]> = [
    ['https://\u0661\u0662\u0663.com/x', '\u0661\u0662\u0663.com'],
    ['https://shop\u0663.com', 'shop\u0663.com'],
    ['https://a\u0640b.com', 'a\u0640b.com'],
    ['https://a.\u05e9b.com', 'a.\u05e9b.com'],
    ['https://xn--bcher-kva.de/a', 'xn--bcher-kva.de'],
    ['https://B\u00fccher.DE', 'b\u00fccher.de'],
    ['https://WWW.Example.com:8080/p?q#f', 'example.com'],
    ['https://u:p@host.test', 'host.test'],
    ['http://[::1]:80/', '[::1]'],
    ['a://@', null],
    ['mailto:a@b.test', null],
    ['https:x.test', null],
    ['https://x.test:65536', null],
    ['https://%41.test', null]
  ]

  it.each(hostRows)('decides %s by the host rule', (rowUrl, domain) => {
    const payload = encodeURIComponent(rowUrl)
    const { segments } = splitTextWithLinkMentions(
      `A ((mention:${payload})) B ((mention:${payload} )) C`
    )
    const chips = segments.filter((segment) => typeof segment !== 'string')
    expect(chips).toEqual(
      Array(domain === null ? 1 : 2).fill(createLinkMentionContent(rowUrl, domain ?? rowUrl))
    )
  })

  it('is a no-op when no token is present', () => {
    const { segments, didChange } = splitTextWithLinkMentions('plain text')
    expect(didChange).toBe(false)
    expect(segments).toEqual(['plain text'])
  })
})

describe('normalizeLinkMentions', () => {
  it('reconstructs linkMention inline content from a token in a paragraph', () => {
    const blocks = [
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: `see ${token}`, styles: {} }],
        children: []
      }
    ] as unknown as Block[]

    const { blocks: out, didChange } = normalizeLinkMentions(blocks)
    expect(didChange).toBe(true)
    const content = (out[0] as any).content
    expect(content[0]).toEqual({ type: 'text', text: 'see ', styles: {} })
    expect(content[1]).toEqual({
      type: 'linkMention',
      props: { url, domain: 'eksisozluk.com', title: '', favicon: '', siteName: '' }
    })
  })

  it('recurses into children and leaves code blocks untouched', () => {
    const blocks = [
      {
        type: 'codeBlock',
        props: {},
        content: [{ type: 'text', text: token, styles: {} }],
        children: []
      },
      {
        type: 'bulletListItem',
        props: {},
        content: [{ type: 'text', text: 'x', styles: {} }],
        children: [
          {
            type: 'paragraph',
            props: {},
            content: [{ type: 'text', text: token, styles: {} }],
            children: []
          }
        ]
      }
    ] as unknown as Block[]

    const { blocks: out, didChange } = normalizeLinkMentions(blocks)
    expect(didChange).toBe(true)
    // code block text stays literal
    expect((out[0] as any).content[0].text).toBe(token)
    // nested paragraph reconstructed
    expect((out[1] as any).children[0].content[0].type).toBe('linkMention')
  })

  it('promotes a mention nested under a code block, and not in the code itself', () => {
    const blocks = [
      {
        type: 'codeBlock',
        props: {},
        content: [{ type: 'text', text: token, styles: {} }],
        children: [
          {
            type: 'bulletListItem',
            props: {},
            content: [{ type: 'text', text: token, styles: {} }],
            children: []
          }
        ]
      }
    ] as unknown as Block[]

    const { blocks: out, didChange } = normalizeLinkMentions(blocks)
    expect(didChange).toBe(true)
    expect((out[0] as any).content[0].text).toBe(token)
    expect((out[0] as any).children[0].content[0].type).toBe('linkMention')
  })

  it('is a no-op when no token is present', () => {
    const blocks = [
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'just text', styles: {} }],
        children: []
      }
    ] as unknown as Block[]
    const result = normalizeLinkMentions(blocks)
    expect(result.didChange).toBe(false)
    expect(result.blocks).toBe(blocks)
  })
})
