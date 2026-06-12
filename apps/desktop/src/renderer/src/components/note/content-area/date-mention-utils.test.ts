import { describe, it, expect } from 'vitest'
import type { Block } from '@blocknote/core'
import { normalizeDateMentions } from './date-mention-utils'
import { serializeDateMentionToken } from '@memry/shared/date-mention'

const token = serializeDateMentionToken({
  anchorId: 'dm_1',
  dateISO: '2026-06-20T09:00:00.000Z',
  hasTime: true,
  remind: true,
  lead: '1h'
})

function paragraph(text: string): Block {
  return {
    id: 'b1',
    type: 'paragraph',
    props: {},
    content: [{ type: 'text', text, styles: {} }],
    children: []
  } as unknown as Block
}

describe('normalizeDateMentions', () => {
  it('replaces a token text node with a dateMention inline content', () => {
    const { blocks, didChange } = normalizeDateMentions([paragraph(`due ${token}`)])
    expect(didChange).toBe(true)
    const content = (blocks[0] as any).content
    const mention = content.find((c: any) => c.type === 'dateMention')
    expect(mention.props.anchorId).toBe('dm_1')
    expect(content[0]).toMatchObject({ type: 'text', text: 'due ' })
  })

  it('returns didChange=false when there is no token', () => {
    const { didChange } = normalizeDateMentions([paragraph('plain text')])
    expect(didChange).toBe(false)
  })
})
