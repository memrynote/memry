import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import type { EditorSchema } from '../editor-schema'
import { usePortalDeleteGuard } from './use-portal-delete-guard'

const mocks = vi.hoisted(() => ({ getUsage: vi.fn(), toast: vi.fn() }))

vi.mock('./portal-api', () => ({ getPortalUsage: mocks.getUsage }))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: { count?: number }) =>
      key.startsWith('portalFlows.deleteGuard.description')
        ? `shown in ${values?.count}`
        : key.replace('portalFlows.deleteGuard.', '')
  })
}))

const host = { noteId: 'lab', title: 'Lab 4', path: 'Lab 4.md', count: 1 }

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

async function mountEditor(): Promise<BlockNoteEditor> {
  const editor = BlockNoteEditor.create()
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'Chloroplast ^chl-7f2a' },
    { type: 'paragraph', content: 'Plain block' }
  ])
  return editor
}

type Request = (ids: readonly string[]) => Promise<void>

function Harness({
  editor,
  removeFromPortal,
  requestRef
}: {
  editor: BlockNoteEditor
  removeFromPortal?: (ids: readonly string[]) => void
  requestRef: { current: Request | null }
}) {
  const guard = usePortalDeleteGuard({
    editor: editor as unknown as EditorSchema['BlockNoteEditor'],
    noteId: 'cell-biology',
    noteTitle: 'Cell Biology',
    removeFromPortal
  })
  requestRef.current = guard.requestBlockRemoval
  return guard.dialog
}

const setup = async (removeFromPortal?: (ids: readonly string[]) => void) => {
  const editor = await mountEditor()
  const requestRef: { current: Request | null } = { current: null }
  render(<Harness editor={editor} removeFromPortal={removeFromPortal} requestRef={requestRef} />)
  return { editor, request: (ids: readonly string[]) => requestRef.current!(ids) }
}

// jsdom has no layout; BlockNote's side menu asks for the element under the
// pointer on every mousemove, which user-event fires.
beforeAll(() => {
  document.elementsFromPoint = () => []
})

beforeEach(() => {
  mocks.getUsage.mockReset()
  mocks.toast.mockReset()
})

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

describe('usePortalDeleteGuard: menu delete', () => {
  it('deletes without asking when no other note shows the block', async () => {
    mocks.getUsage.mockResolvedValue([])
    const { editor, request } = await setup()
    await act(() => request([editor.document[0].id]))
    expect(editor.document).toHaveLength(1)
    expect(screen.queryByTestId('portal-delete-dialog')).toBeNull()
  })

  it('never looks up usage for a block with no anchor', async () => {
    const { editor, request } = await setup()
    await act(() => request([editor.document[1].id]))
    expect(mocks.getUsage).not.toHaveBeenCalled()
    expect(editor.document).toHaveLength(1)
  })

  it('asks first, and keeps the block on cancel', async () => {
    mocks.getUsage.mockResolvedValue([host])
    const user = userEvent.setup()
    const { editor, request } = await setup()
    let done: Promise<void> | undefined
    act(() => {
      done = request([editor.document[0].id])
    })
    await user.click(await screen.findByText('cancel'))
    await act(async () => done)
    expect(editor.document).toHaveLength(2)
  })

  it('deletes everywhere on confirm, with no undo toast on top', async () => {
    mocks.getUsage.mockResolvedValue([host])
    const user = userEvent.setup()
    const { editor, request } = await setup()
    let done: Promise<void> | undefined
    act(() => {
      done = request([editor.document[0].id])
    })
    await user.click(await screen.findByText('everywhere'))
    await act(async () => done)
    expect(editor.document).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('hides the block from the portal on "remove from this portal only"', async () => {
    mocks.getUsage.mockResolvedValue([host])
    const removeFromPortal = vi.fn()
    const user = userEvent.setup()
    const { editor, request } = await setup(removeFromPortal)
    const id = editor.document[0].id
    act(() => {
      void request([id])
    })
    await user.click(await screen.findByText('removeHere'))
    await waitFor(() => {
      expect(removeFromPortal).toHaveBeenCalledWith([id])
    })
    expect(editor.document).toHaveLength(2)
  })
})

describe('usePortalDeleteGuard: keyboard delete', () => {
  it('offers Undo when a block shown elsewhere was removed without the menu', async () => {
    mocks.getUsage.mockResolvedValue([host])
    const { editor } = await setup()
    act(() => {
      editor.removeBlocks([editor.document[0].id])
    })
    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledTimes(1)
    })
    const [message, options] = mocks.toast.mock.calls[0]
    expect(message).toBe('undoToast')
    expect(options.action.label).toBe('undo')
  })

  it('stays quiet for a block nobody else shows', async () => {
    mocks.getUsage.mockResolvedValue([])
    const { editor } = await setup()
    act(() => {
      editor.removeBlocks([editor.document[0].id])
    })
    await waitFor(() => {
      expect(mocks.getUsage).toHaveBeenCalled()
    })
    expect(mocks.toast).not.toHaveBeenCalled()
  })
})
