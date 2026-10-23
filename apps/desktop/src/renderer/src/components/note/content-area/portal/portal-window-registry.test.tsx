/**
 * One portal block is drawn by several editors at once (the host in two panes,
 * a source tab beside its host). Each draw is its own instance: its own
 * registry entry, its own plugins, and actions that reach only its own window.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { parsePortalDefinition } from '@memry/shared/portal-block'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import { createPortalActions } from './portal-actions'
import { portalBlockInput, portalBlockText } from './portal-definition'
import type { PortalInlineHandlers } from './portal-inline-plugin'
import type { PortalHandle } from './portal-slots'
import { para, mountTestEditor, unmountTestEditors } from './portal-test-editor'
import { getPortalWindowState } from './portal-window-plugin'
import { getPortalWindow, registerPortalWindow } from './portal-window-registry'
import { mountPortalWindow } from './portal-window-test-editor'
import { usePortalInlineMarks, usePortalWindowState } from './use-portal-window-view'

afterEach(unmountTestEditors)

const A = { blockId: 'p1', instanceId: 'a' }
const B = { blockId: 'p1', instanceId: 'b' }

const spec = (blocks: string[]) => ({ kind: 'blocks' as const, note: 'src', blocks, open: {} })

function mountWindow(blocks: string[]) {
  return mountPortalWindow([para('Parent ^par1', [para('Child ^chd1')])], spec(blocks))
}

const handlers = (): { current: PortalInlineHandlers } => ({
  current: {
    hiddenLabel: (n) => `${n} hidden`,
    foldLabel: () => 'fold',
    editable: true,
    openHidden: vi.fn(),
    toggleFold: vi.fn()
  }
})

describe('portal window registry', () => {
  it('keeps two instances of one block apart, and unmounting one leaves the other', () => {
    const a = mountWindow(['chd1'])
    const b = mountWindow(['par1'])
    const offA = registerPortalWindow(A, { view: a.view, sourceNoteId: 'src' })
    const offB = registerPortalWindow(B, { view: b.view, sourceNoteId: 'src' })

    expect(getPortalWindow(A)?.view).toBe(a.view)
    expect(getPortalWindow(B)?.view).toBe(b.view)

    offA()
    expect(getPortalWindow(A)).toBeUndefined()
    expect(getPortalWindow(B)?.view).toBe(b.view)
    offB()
  })

  it('a stale unregister (StrictMode double mount) cannot drop a newer entry of the same instance', () => {
    const first = mountWindow(['chd1'])
    const second = mountWindow(['chd1'])
    const offFirst = registerPortalWindow(A, { view: first.view, sourceNoteId: 'src' })
    const offSecond = registerPortalWindow(A, { view: second.view, sourceNoteId: 'src' })

    offFirst()
    expect(getPortalWindow(A)?.view).toBe(second.view)
    offSecond()
  })

  it('reads the window state of its own instance only', () => {
    const a = mountWindow(['chd1'])
    const b = mountWindow(['par1'])
    const offA = registerPortalWindow(A, { view: a.view, sourceNoteId: 'src' })
    const offB = registerPortalWindow(B, { view: b.view, sourceNoteId: 'src' })

    const stateA = renderHook(() => usePortalWindowState(A)).result.current
    const stateB = renderHook(() => usePortalWindowState(B)).result.current
    expect(stateA?.visible.map((x) => x.text)).toEqual(['Child'])
    expect(stateB?.visible.map((x) => x.text)).toEqual(['Parent'])
    offA()
    offB()
  })

  it('puts the inline marks on each instance own editor, and never throws on a shared block id', () => {
    const a = mountWindow(['par1'])
    const b = mountWindow(['par1'])
    const offA = registerPortalWindow(A, { view: a.view, sourceNoteId: 'src' })
    const offB = registerPortalWindow(B, { view: b.view, sourceNoteId: 'src' })

    expect(() => {
      renderHook(() => {
        usePortalInlineMarks(A, handlers())
      })
      renderHook(() => {
        usePortalInlineMarks(B, handlers())
      })
    }).not.toThrow()
    const keyed = (view: typeof a.view) =>
      view.state.plugins.filter((p) =>
        (p as unknown as { key: string }).key.includes('portalInline')
      )
    expect(keyed(a.view)).toHaveLength(1)
    expect(keyed(b.view)).toHaveLength(1)
    offA()
    offB()
  })

  it('an action on instance A edits from A window even when B registered last', async () => {
    const host = mountTestEditor([para('before')])
    host.editor.insertBlocks(
      [
        portalBlockInput(
          (() => {
            const parsed = parsePortalDefinition(
              JSON.stringify({ v: 1, note: 'src', blocks: ['chd1'] }, null, 2)
            )
            if (!parsed.ok) throw new Error('bad fence')
            return parsed.definition
          })()
        )
      ],
      host.editor.document[0],
      'after'
    )
    const blockId = host.editor.document[1].id
    const a = mountWindow(['chd1'])
    const b = mountPortalWindow([para('Other ^oth1')], spec(['oth1']))
    const offA = registerPortalWindow(
      { blockId, instanceId: 'a' },
      { view: a.view, sourceNoteId: 'src' }
    )
    const offB = registerPortalWindow(
      { blockId, instanceId: 'b' },
      { view: b.view, sourceNoteId: 'src' }
    )

    const fenceOf = () => portalBlockText(host.editor.getBlock(blockId)?.content)
    const read = (): PortalHandle => {
      const parsed = parsePortalDefinition(fenceOf())
      if (!parsed.ok) throw new Error('fence unreadable')
      return {
        blockId,
        instanceId: 'a',
        editor: host.editor as unknown as PortalHandle['editor'],
        definition: parsed.definition,
        sourceNoteId: 'src',
        hostNoteId: undefined
      }
    }
    const parent = getPortalWindowState(a.view)!.ancestors[0]!
    let done = false
    await act(async () => {
      done = await createPortalActions(read).includeParent(parent.blockId)
    })

    expect(done).toBe(true)
    expect(JSON.parse(fenceOf()).blocks).toEqual(['par1'])
    expect(getPortalWindowState(b.view)?.visible.map((x) => x.text)).toEqual(['Other'])
    offA()
    offB()
  })
})
