import { describe, it, expect } from 'vitest'
import type { Block } from '@blocknote/core'
import { serializeDateMentionToken, type DateMentionData } from '@memry/shared/date-mention'
import { normalizeDateMentions } from './date-mention-normalize'

const data: DateMentionData = {
  anchorId: 'dm_1',
  dateISO: '2026-06-20T09:00:00.000Z',
  hasTime: true,
  dateFormat: 'relative',
  remind: '1h',
  timeFormat: 'system'
}
const token = serializeDateMentionToken(data)
const node = { type: 'dateMention', props: data }

/** base64 the way the token encodes it, for payloads no writer emits. */
const rawToken = (payload: unknown): string =>
  `((date:${btoa(JSON.stringify(payload)).replace(/\+/g, ',').replace(/\//g, ';').replace(/=+$/, '')}))`

function block(type: string, content: unknown, children: Block[] = []): Block {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture in BlockNote's structural block shape
  return { id: 'b', type, props: {}, content, children } as unknown as Block
}

const paragraph = (text: string, styles: Record<string, boolean | string> = {}): Block =>
  block('paragraph', [{ type: 'text', text, styles }])

const contentOf = (b: Block | undefined): unknown =>
  (b as { content?: unknown } | undefined)?.content

describe('normalizeDateMentions', () => {
  it('replaces a token with a dateMention node and keeps the text around it', () => {
    const { blocks, didChange } = normalizeDateMentions([paragraph(`due ${token} ok`)])
    expect(didChange).toBe(true)
    expect(contentOf(blocks[0])).toEqual([
      { type: 'text', text: 'due ', styles: {} },
      node,
      { type: 'text', text: ' ok', styles: {} }
    ])
  })

  it('salvages a legacy token the strict parse refuses to a plain date', () => {
    const legacy = rawToken({ anchorId: 'dm_old', dateISO: '2026-06-20', remind: true, lead: 1 })
    const { blocks } = normalizeDateMentions([paragraph(legacy)])
    expect(contentOf(blocks[0])).toEqual([
      {
        type: 'dateMention',
        props: {
          anchorId: 'dm_old',
          dateISO: '2026-06-20',
          hasTime: false,
          dateFormat: 'relative',
          remind: 'none',
          timeFormat: 'system'
        }
      }
    ])
  })

  it('leaves a token with no usable date as text', () => {
    const blocks = [paragraph(rawToken({ anchorId: 'dm_x', dateISO: 'not a date' }))]
    expect(normalizeDateMentions(blocks)).toEqual({ blocks, didChange: false })
  })

  it('keeps a token in a styled run as text (#4652)', () => {
    const styled: Array<Record<string, boolean | string>> = [
      { bold: true },
      { code: true },
      { textColor: 'red' }
    ]
    for (const styles of styled) {
      const blocks = [paragraph(`a ${token}`, styles)]
      expect(normalizeDateMentions(blocks)).toEqual({ blocks, didChange: false })
    }
  })

  it('promotes a token in a table cell', () => {
    const table = block('table', {
      type: 'tableContent',
      rows: [
        {
          cells: [
            { type: 'tableCell', props: {}, content: [{ type: 'text', text: token, styles: {} }] }
          ]
        }
      ]
    })
    const { blocks, didChange } = normalizeDateMentions([table])
    expect(didChange).toBe(true)
    const cell = (contentOf(blocks[0]) as { rows: Array<{ cells: Array<{ content: unknown }> }> })
      .rows[0].cells[0]
    expect(cell.content).toEqual([node])
  })

  it('keeps a code block literal and promotes a token nested under it', () => {
    const code = block(
      'codeBlock',
      [{ type: 'text', text: token, styles: {} }],
      [block('bulletListItem', `due ${token}`)]
    )
    const { blocks, didChange } = normalizeDateMentions([code])
    expect(didChange).toBe(true)
    expect(contentOf(blocks[0])).toEqual([{ type: 'text', text: token, styles: {} }])
    expect(contentOf(blocks[0]?.children[0])).toEqual(['due ', node])
  })

  it('returns the same blocks when there is no token', () => {
    const blocks = [paragraph('plain text')]
    expect(normalizeDateMentions(blocks).blocks).toBe(blocks)
  })
})
