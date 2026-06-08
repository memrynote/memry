import { describe, expect, it } from 'vitest'

import type { Block } from '@blocknote/core'
import { normalizeLinkMentions, splitTextWithLinkMentions } from './link-mention-utils'
import { serializeLinkMentionToken } from './link-mention'

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

  it('preserves styles on surrounding text segments', () => {
    const styles = { bold: true }
    const { segments } = splitTextWithLinkMentions(`a ${token}`, styles)
    expect(segments[0]).toEqual({ type: 'text', text: 'a ', styles })
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
