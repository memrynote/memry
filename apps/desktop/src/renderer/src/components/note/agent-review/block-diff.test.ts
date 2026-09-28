import { describe, expect, it } from 'vitest'

import { buildBlockDiff, DIFF_ADD_STYLE, DIFF_DEL_STYLE, type DiffableBlock } from './block-diff'

let seq = 0
function paragraph(text: string, children: DiffableBlock[] = []): DiffableBlock {
  return {
    id: `id-${seq++}`,
    type: 'paragraph',
    props: {},
    content: text ? [{ type: 'text', text, styles: {} }] : [],
    children
  }
}

function bullet(text: string, children: DiffableBlock[] = []): DiffableBlock {
  return { ...paragraph(text, children), type: 'bulletListItem' }
}

function texts(block: DiffableBlock): { text: string; styles: Record<string, unknown> }[] {
  return (block.content as { text: string; styles: Record<string, unknown> }[]).map(
    ({ text, styles }) => ({ text, styles })
  )
}

describe('buildBlockDiff', () => {
  it('keeps untouched blocks once, with fresh ids and no change', () => {
    const { blocks, changeCount } = buildBlockDiff(
      [paragraph('One'), paragraph('Two')],
      [paragraph('One'), paragraph('Two')]
    )

    expect(changeCount).toBe(0)
    expect(blocks.map((block) => block.id)).toEqual(['diff-ctx-0', 'diff-ctx-1'])
    expect(texts(blocks[0])).toEqual([{ text: 'One', styles: {} }])
  })

  it('diffs an edited paragraph word by word', () => {
    const { blocks, changeCount } = buildBlockDiff(
      [paragraph('Ship by Friday.')],
      [paragraph('Ship by Thursday.')]
    )

    expect(changeCount).toBe(1)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].id).toBe('diff-mod-0')
    expect(texts(blocks[0])).toEqual([
      { text: 'Ship by ', styles: {} },
      { text: 'Friday', styles: { backgroundColor: DIFF_DEL_STYLE, strike: true } },
      { text: 'Thursday', styles: { backgroundColor: DIFF_ADD_STYLE } },
      { text: '.', styles: {} }
    ])
  })

  it('shows a removed block struck through and an added block highlighted', () => {
    const { blocks, changeCount } = buildBlockDiff(
      [bullet('Keep'), bullet('Passport photos')],
      [bullet('Keep'), paragraph('Dentist')]
    )

    expect(changeCount).toBe(1)
    expect(blocks.map((block) => block.id)).toEqual(['diff-ctx-0', 'diff-del-1', 'diff-add-2'])
    expect(texts(blocks[1])).toEqual([
      { text: 'Passport photos', styles: { backgroundColor: DIFF_DEL_STYLE, strike: true } }
    ])
    expect(texts(blocks[2])).toEqual([
      { text: 'Dentist', styles: { backgroundColor: DIFF_ADD_STYLE } }
    ])
  })

  it('marks a changed child without touching its parent', () => {
    const { blocks, changeCount } = buildBlockDiff(
      [bullet('Parent', [bullet('Old child')])],
      [bullet('Parent', [bullet('New child'), bullet('Added child')])]
    )

    expect(changeCount).toBe(1)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].id).toBe('diff-ctx-0')
    expect(blocks[0].children.map((child) => child.id)).toEqual(['diff-mod-1', 'diff-add-2'])
  })

  it('treats an unchanged link as unchanged text around it', () => {
    const link = {
      type: 'link',
      href: 'https://memry.app',
      content: [{ type: 'text', text: 'site', styles: {} }]
    }
    const before: DiffableBlock = {
      ...paragraph(''),
      content: [
        { type: 'text', text: 'See ', styles: {} },
        link,
        { type: 'text', text: ' now', styles: {} }
      ]
    }
    const after: DiffableBlock = {
      ...paragraph(''),
      content: [
        { type: 'text', text: 'Read ', styles: {} },
        link,
        { type: 'text', text: ' now', styles: {} }
      ]
    }

    const { blocks } = buildBlockDiff([before], [after])
    const content = blocks[0].content as unknown[]

    expect(content).toContainEqual(link)
    expect(content).toContainEqual({
      type: 'text',
      text: 'See',
      styles: { backgroundColor: DIFF_DEL_STYLE, strike: true }
    })
  })
})
