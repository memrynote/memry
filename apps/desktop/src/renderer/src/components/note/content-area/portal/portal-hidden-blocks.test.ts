import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))
const stamp = vi.hoisted(() => vi.fn())
vi.mock('./portal-api', () => ({ stampPortalAnchor: stamp }))

import { listPortalWindowBlocks, togglePortalBlockHidden } from './portal-hidden-blocks'
import { mountTestEditor, para, unmountTestEditors } from './portal-test-editor'

afterEach(() => {
  unmountTestEditors()
  stamp.mockReset()
})

function portalEditor(definition: string) {
  let text = definition
  return {
    isEditable: true,
    getBlock: () => ({ content: [{ type: 'text', text }] }),
    updateBlock: (_id: string, update: { content: string }) => {
      text = update.content
    },
    removeBlocks: () => {},
    read: () => JSON.parse(text) as { hidden?: string[] }
  }
}

describe('listPortalWindowBlocks', () => {
  it('lists what a block window can hide, flagging hidden blocks and what sits under them', () => {
    const { view } = mountTestEditor([
      para('outside'),
      para('Root ^root1', [
        para('plain child'),
        para('Dropped ^drop1', [para('under dropped')]),
        para('Anchored ^keep1')
      ])
    ])

    const blocks = listPortalWindowBlocks(view.state.doc, { anchor: 'root1', hidden: ['drop1'] })

    expect(blocks.map((b) => [b.text, b.depth, b.anchor, b.hidden, b.hiddenByAncestor])).toEqual([
      ['plain child', 0, null, false, false],
      ['Dropped', 0, 'drop1', true, false],
      ['under dropped', 1, null, false, true],
      ['Anchored', 0, 'keep1', false, false]
    ])
  })

  it('leaves out blocks with no text but keeps what is nested under them', () => {
    const { view } = mountTestEditor([
      para('Root ^root1', [para(''), para('   ', [para('under empty')]), para('real child')])
    ])

    const blocks = listPortalWindowBlocks(view.state.doc, { anchor: 'root1', hidden: [] })

    expect(blocks.map((b) => [b.text, b.depth])).toEqual([
      ['under empty', 0],
      ['real child', 0]
    ])
  })

  it('lists every block of a whole-note window', () => {
    const { view } = mountTestEditor([para('one'), para('two')])

    const blocks = listPortalWindowBlocks(view.state.doc, { anchor: null, hidden: [] })

    expect(blocks.map((b) => b.text)).toEqual(['one', 'two'])
  })
})

describe('togglePortalBlockHidden', () => {
  it('stamps an anchor on a block that has none, then hides it', async () => {
    stamp.mockResolvedValue({ success: true, anchor: 'new123' })
    const editor = portalEditor('{"note":"src","block":"root1"}')

    const ok = await togglePortalBlockHidden({
      editor,
      portalBlockId: 'p',
      sourceNoteId: 'src',
      block: { id: 'blk', anchor: null, hidden: false }
    })

    expect(ok).toBe(true)
    expect(stamp).toHaveBeenCalledWith('src', 'blk')
    expect(editor.read().hidden).toEqual(['new123'])
  })

  it('shows a hidden block again without asking main for anything', async () => {
    const editor = portalEditor('{"note":"src","block":"root1","hidden":["keep1","drop1"]}')

    await togglePortalBlockHidden({
      editor,
      portalBlockId: 'p',
      sourceNoteId: 'src',
      block: { id: 'blk', anchor: 'drop1', hidden: true }
    })

    expect(stamp).not.toHaveBeenCalled()
    expect(editor.read().hidden).toEqual(['keep1'])
  })

  it('leaves the definition alone when the source refuses the anchor', async () => {
    stamp.mockResolvedValue({ success: false, reason: 'locked' })
    const editor = portalEditor('{"note":"src","block":"root1"}')

    const ok = await togglePortalBlockHidden({
      editor,
      portalBlockId: 'p',
      sourceNoteId: 'src',
      block: { id: 'blk', anchor: null, hidden: false }
    })

    expect(ok).toBe(false)
    expect(editor.read().hidden).toBeUndefined()
  })
})
