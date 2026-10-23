/**
 * The marks a portal draws on its window, on a real editor: an "N hidden" row
 * under a block with children left out, and a fold chevron that says whether
 * the block's children are open.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import { registerEditorPlugin } from '../register-editor-plugin'
import { createPortalInlinePlugin, type PortalInlineHandlers } from './portal-inline-plugin'
import { para, unmountTestEditors } from './portal-test-editor'
import { mountPortalWindow } from './portal-window-test-editor'
import { getPortalWindowState } from './portal-window-plugin'

afterEach(unmountTestEditors)

function mount(open: Record<string, { mode: 'show' | 'hide'; ids: string[] }>) {
  const mounted = mountPortalWindow(
    [para('DNA ^dna1', [para('shown ^shw1'), para('left out ^lft1'), para('also left out')])],
    { kind: 'blocks', note: 'src', blocks: ['dna1'], open }
  )
  const handlers: PortalInlineHandlers = {
    hiddenLabel: (count) => `${count} hidden`,
    foldLabel: (expanded) => (expanded ? 'Hide children' : 'Show children'),
    editable: true,
    openHidden: vi.fn(),
    toggleFold: vi.fn()
  }
  registerEditorPlugin(mounted.editor, createPortalInlinePlugin({ current: handlers }))
  const root = mounted.view.dom as HTMLElement
  const dnaId = getPortalWindowState(mounted.view)!.visible[0]!.blockId
  return { ...mounted, root, handlers, dnaId }
}

describe('portal inline marks', () => {
  it('counts the children left out under their parent, and opens the list for it', () => {
    const { root, handlers, dnaId } = mount({ dna1: { mode: 'show', ids: ['shw1'] } })

    const button = root.querySelector<HTMLElement>('.portal-hidden-row-button')
    expect(button?.textContent).toBe('2 hidden')
    button!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

    expect(handlers.openHidden).toHaveBeenCalledWith(dnaId, button)
  })

  it('shows an open chevron on an expanded block, and folds it on press', () => {
    const { root, handlers, dnaId } = mount({ dna1: { mode: 'show', ids: ['shw1'] } })

    const fold = root.querySelector<HTMLElement>('[data-portal-fold]')
    expect(fold?.getAttribute('aria-expanded')).toBe('true')
    fold!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

    expect(handlers.toggleFold).toHaveBeenCalledWith(dnaId, true)
  })

  it('shows a closed chevron and no count on a collapsed block', () => {
    const { root, handlers, dnaId } = mount({})

    const fold = root.querySelector<HTMLElement>('[data-portal-fold]')
    expect(fold?.getAttribute('aria-expanded')).toBe('false')
    // The chevron alone says it is folded; the count is for an opened, partly hidden block.
    expect(root.querySelector('.portal-hidden-row')).toBeNull()
    fold!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

    expect(handlers.toggleFold).toHaveBeenCalledWith(dnaId, false)
  })

  it('counts the children left out of an opened block', () => {
    const { root } = mount({ dna1: { mode: 'show', ids: [] } })

    expect(root.querySelector('.portal-hidden-row-button')?.textContent).toBe('3 hidden')
  })

  it('draws nothing once every child is shown in hide mode with none hidden', () => {
    const { root } = mount({ dna1: { mode: 'hide', ids: [] } })

    expect(root.querySelector('.portal-hidden-row')).toBeNull()
  })
})
