/**
 * The whiteboard block: a canvas drawn inside a note.
 *
 * Excalidraw cannot run in jsdom, and the editor the block mounts is the canvas
 * tab's own (its persistence is canvas-editor.test.tsx's subject), so here it
 * is a prop recorder. What is only true here is the block's contract around
 * it: which states mount an editor at all, that Done saves before it stops
 * editing, that a change made elsewhere replaces what a viewing board shows
 * but never what an editing one holds, and that `/whiteboard` creates the
 * note-owned canvas before it writes the block.
 */

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BlockNoteEditor } from '@blocknote/core'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas } from '@/services/canvas-service'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(),
  flush: vi.fn(),
  toastError: vi.fn(),
  flags: { spatialCanvas: true },
  updateListeners: new Set<(event: { canvas: { id: string; title: string | null } }) => void>(),
  /** Editor instances mounted so far; a remount shows up as a second one. */
  mounts: 0
}))

// pdf.js touches `DOMMatrix` at import time, which jsdom has none of. The rest
// of the schema is real.
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => mocks.toastError(...args) } }))
vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({ flags: mocks.flags, isLoading: false })
}))
vi.mock('@/contexts/tabs', () => ({ useTabActions: () => ({ openTab: vi.fn() }) }))
vi.mock('@/services/canvas-service', () => ({
  canvasService: {
    get: (...args: unknown[]) => mocks.get(...args),
    create: (...args: unknown[]) => mocks.create(...args)
  },
  onCanvasUpdated: (
    listener: (event: { canvas: { id: string; title: string | null } }) => void
  ) => {
    mocks.updateListeners.add(listener)
    return () => mocks.updateListeners.delete(listener)
  },
  onCanvasCreated: () => () => {},
  onCanvasDeleted: () => () => {}
}))
vi.mock('@/pages/canvas/canvas-editor', () => ({
  CanvasEditor: ({
    initialScene,
    embed,
    ref
  }: {
    initialScene: string
    embed?: { editing: boolean }
    ref?: React.Ref<{ flush: () => Promise<void> }>
  }) => {
    React.useImperativeHandle(ref, () => ({ flush: () => mocks.flush() }), [])
    React.useEffect(() => {
      mocks.mounts += 1
    }, [])
    return (
      <div
        data-testid="canvas-editor"
        data-scene={initialScene}
        data-editing={String(embed?.editing)}
      />
    )
  }
}))

import { InsideCanvasSurfaceContext } from '@/pages/canvas/canvas-surface-context'
import { editorSchema } from './editor-schema'
import { getWhiteboardSlashMenuItem, WhiteboardBlockRenderer } from './whiteboard-block'

function canvas(overrides: Partial<Canvas> = {}): Canvas {
  return {
    id: 'cv-1',
    title: 'Trip plan',
    folder: null,
    icon: null,
    ownerNoteId: 'note-1',
    createdAt: 1,
    updatedAt: 1,
    scene: 'scene-a',
    ...overrides
  }
}

function changedElsewhere(): void {
  for (const listener of mocks.updateListeners) {
    listener({ canvas: { id: 'cv-1', title: 'Trip plan' } })
  }
}

const board = <WhiteboardBlockRenderer block={{ props: { canvasId: 'cv-1' } }} />

beforeEach(() => {
  vi.clearAllMocks()
  mocks.flags.spatialCanvas = true
  mocks.mounts = 0
  mocks.flush.mockResolvedValue(undefined)
})

describe('WhiteboardBlockRenderer', () => {
  it('shows the drawing read-only, and Done saves before it stops editing', async () => {
    // #given a readable board
    const user = userEvent.setup()
    mocks.get.mockResolvedValue(canvas())
    render(board)
    expect(await screen.findByTestId('canvas-editor')).toHaveAttribute('data-editing', 'false')

    // #when the author edits, then finishes
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByTestId('canvas-editor')).toHaveAttribute('data-editing', 'true')
    let editingWhenSaved: string | null = null
    mocks.flush.mockImplementation(async () => {
      editingWhenSaved = screen.getByTestId('canvas-editor').getAttribute('data-editing')
    })
    await user.click(screen.getByRole('button', { name: 'Done' }))

    // #then the save ran while the surface was still live, and the same
    // editor carries on in view mode rather than being rebuilt
    expect(editingWhenSaved).toBe('true')
    await waitFor(() =>
      expect(screen.getByTestId('canvas-editor')).toHaveAttribute('data-editing', 'false')
    )
    expect(mocks.mounts).toBe(1)
  })

  it('replaces a viewed board changed elsewhere, but never one being edited', async () => {
    // #given a board on screen in view mode
    const user = userEvent.setup()
    mocks.get.mockResolvedValue(canvas({ scene: 'scene-a' }))
    render(board)
    await screen.findByTestId('canvas-editor')

    // #when another tab or device changes the canvas
    mocks.get.mockResolvedValue(canvas({ scene: 'scene-b' }))
    act(() => changedElsewhere())

    // #then a fresh editor shows the new drawing
    await waitFor(() =>
      expect(screen.getByTestId('canvas-editor')).toHaveAttribute('data-scene', 'scene-b')
    )
    expect(mocks.mounts).toBe(2)

    // #when it changes again while the author is drawing here
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    mocks.get.mockClear()
    mocks.get.mockResolvedValue(canvas({ scene: 'scene-c' }))
    act(() => changedElsewhere())

    // #then the live surface is left alone — the update is its own save
    // echoing back, or loses to it anyway
    expect(mocks.get).not.toHaveBeenCalled()
    expect(screen.getByTestId('canvas-editor')).toHaveAttribute('data-scene', 'scene-b')
    expect(mocks.mounts).toBe(2)
  })

  it('never mounts an editor over a canvas this device cannot read', async () => {
    // #given an index row whose document is missing here — an editor's first
    // autosave would write an empty scene over ink that is still recoverable
    mocks.get.mockResolvedValue(canvas({ unreadable: true, scene: '' }))

    // #when
    render(board)

    // #then
    expect(await screen.findByText('This whiteboard cannot be opened here')).toBeInTheDocument()
    expect(screen.queryByTestId('canvas-editor')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('says so when the canvas does not exist on this device', async () => {
    mocks.get.mockResolvedValue(null)

    render(board)

    expect(await screen.findByText('This whiteboard is not available')).toBeInTheDocument()
    expect(screen.queryByTestId('canvas-editor')).toBeNull()
  })

  it('draws no second editor inside a canvas', async () => {
    // #given a note shown on a canvas card, which embeds a board — possibly
    // that same canvas, which would nest without end
    mocks.get.mockResolvedValue(canvas())

    // #when
    render(<InsideCanvasSurfaceContext.Provider value>{board}</InsideCanvasSurfaceContext.Provider>)

    // #then the board is one "Open in tab" away instead
    expect(await screen.findByRole('button', { name: 'Open in tab' })).toBeInTheDocument()
    expect(
      screen.getByText('Open this whiteboard in its own tab to see the drawing.')
    ).toBeVisible()
    expect(screen.queryByTestId('canvas-editor')).toBeNull()
  })

  it('reads nothing while Canvas is turned off', () => {
    mocks.flags.spatialCanvas = false

    render(board)

    expect(screen.getByText('Canvas is turned off')).toBeInTheDocument()
    expect(mocks.get).not.toHaveBeenCalled()
  })
})

describe('getWhiteboardSlashMenuItem', () => {
  const labels = { title: 'Whiteboard', group: 'Media', subtext: 's' }
  const mounted: Array<{ editor: BlockNoteEditor; element: HTMLElement }> = []

  afterEach(() => {
    for (const { editor, element } of mounted.splice(0)) {
      editor.unmount()
      element.remove()
    }
  })

  function editorOnEmptyLine() {
    const editor = BlockNoteEditor.create({ schema: editorSchema })
    const element = document.createElement('div')
    document.body.appendChild(element)
    editor.mount(element)
    mounted.push({ editor: editor as unknown as BlockNoteEditor, element })
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'Intro' },
      { type: 'paragraph' }
    ])
    editor.setTextCursorPosition(editor.document[1], 'end')
    return editor
  }

  it('creates a canvas owned by the note, then turns the empty line into its board', async () => {
    // #given
    mocks.create.mockResolvedValue(canvas({ id: 'cv-new', title: 'Trip whiteboard' }))
    const editor = editorOnEmptyLine()
    const item = getWhiteboardSlashMenuItem(editor, 'note-1', labels, async () => 'Trip')

    // #when
    await item.onItemClick()

    // #then the canvas belongs to this note and is named after it
    expect(mocks.create).toHaveBeenCalledWith({ title: 'Trip whiteboard', ownerNoteId: 'note-1' })
    // the board replaced the line the slash was typed on, and the caret waits
    // on a fresh line below it
    expect(editor.document.map((block) => block.type)).toEqual([
      'paragraph',
      'whiteboard',
      'paragraph'
    ])
    expect(editor.document[1].props).toEqual({ canvasId: 'cv-new' })
    expect(editor.getTextCursorPosition().block.id).toBe(editor.document[2].id)
  })

  it('adds nothing to the note when the canvas cannot be created', async () => {
    // #given — a board with no canvas id writes nothing to disk, so one
    // inserted ahead of a failed create would silently vanish on save
    mocks.create.mockRejectedValue(new Error('Vault is read-only'))
    const editor = editorOnEmptyLine()
    const item = getWhiteboardSlashMenuItem(editor, 'note-1', labels, async () => undefined)

    // #when
    await item.onItemClick()

    // #then
    expect(mocks.toastError).toHaveBeenCalledWith('Vault is read-only')
    expect(editor.document.map((block) => block.type)).toEqual(['paragraph', 'paragraph'])
  })
})
