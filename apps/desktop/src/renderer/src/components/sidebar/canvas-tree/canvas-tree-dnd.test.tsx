/**
 * Drag and drop in the sidebar canvas tree.
 *
 * The suite drives the real drag protocol rather than the handlers: a browser
 * keeps the drag data store in PROTECTED mode for the whole `dragover` phase, so
 * `getData` returns '' until the drop lands. `makeDataTransfer` reproduces that,
 * which is the only way these tests can tell a tree that remembers its payload
 * from one that would silently offer no drop targets in the real app.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasTree } from './canvas-tree'
import { CANVAS_TREE_DRAG_MIME } from './canvas-tree-model'
import { MEMRY_NOTE_DRAG_MIME } from '@/lib/drag-mime'
import { SidebarProvider } from '@/components/ui/sidebar'
import type { CanvasSummary } from '@/services/canvas-service'
import type { CanvasFolder } from '@/services/canvas-folder-service'

const mocks = vi.hoisted(() => ({
  canvas: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    duplicate: vi.fn(),
    revealInFinder: vi.fn(),
    openExternal: vi.fn()
  },
  folder: {
    list: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    move: vi.fn(),
    setIcon: vi.fn(),
    delete: vi.fn()
  },
  toastError: vi.fn()
}))

// The row-level middle-click / preference hooks reach useTabActions, which
// these renders have no TabProvider for — stub the whole open-target module.
vi.mock('@/hooks/use-open-target', () => ({
  useOpenTarget: () => ({ openInNewTab: vi.fn(), openToTheSide: vi.fn() }),
  useOpenPage: () => ({ openPage: vi.fn(), reuseActiveTab: false })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const label = key.split('.').at(-1) ?? key
      return params && 'count' in params ? `${label}:${params.count}` : label
    }
  })
}))

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mocks.toastError(...args) }
}))

vi.mock('@/services/canvas-service', () => ({
  canvasService: mocks.canvas,
  onCanvasCreated: () => () => {},
  onCanvasUpdated: () => () => {},
  onCanvasDeleted: () => () => {}
}))

vi.mock('@/services/canvas-folder-service', () => ({
  canvasFolderService: mocks.folder,
  onCanvasFolderCreated: () => () => {},
  onCanvasFolderUpdated: () => () => {},
  onCanvasFolderDeleted: () => () => {}
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ isActiveItem: () => false })
}))

vi.mock('@/components/sidebar/bookmark-menu-item', () => ({
  BookmarkMenuItem: () => null
}))

/**
 * A `DataTransfer` stand-in. `protectedRead` mirrors the browser's protected
 * drag data store: readable types, unreadable data, for every event between
 * `dragstart` and `drop`.
 */
function makeDataTransfer(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries))
  const transfer = {
    effectAllowed: '',
    dropEffect: '',
    protectedRead: false,
    get types(): string[] {
      return [...store.keys()]
    },
    setData(type: string, value: string): void {
      store.set(type, value)
    },
    getData(type: string): string {
      return transfer.protectedRead ? '' : (store.get(type) ?? '')
    }
  }
  return transfer
}

function canvas(overrides: Partial<CanvasSummary> & { id: string }): CanvasSummary {
  return {
    title: null,
    folder: null,
    icon: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function folder(path: string): CanvasFolder {
  return { id: `cvf_${path.toLowerCase()}`, path, icon: null, createdAt: 1, updatedAt: 1 }
}

function setData(canvases: CanvasSummary[], folders: CanvasFolder[] = []): void {
  mocks.canvas.list.mockResolvedValue({ canvases })
  mocks.folder.list.mockResolvedValue({ folders })
}

function renderTree() {
  return render(
    <SidebarProvider>
      <CanvasTree />
    </SidebarProvider>
  )
}

async function rowsRendered(): Promise<void> {
  await waitFor(() => expect(screen.getAllByTestId('canvas-tree-row').length).toBeGreaterThan(0))
}

function rowFor(label: string): HTMLElement {
  return screen.getByText(label).closest('[data-testid="canvas-tree-row"]') as HTMLElement
}

function rootDropZone(): HTMLElement {
  return screen.getByTestId('canvas-tree-root-drop')
}

/** No service touched — the assertion every refusal shares. */
function expectNothingMoved(): void {
  expect(mocks.canvas.update).not.toHaveBeenCalled()
  expect(mocks.folder.move).not.toHaveBeenCalled()
}

describe('canvas tree drag and drop', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.toastError.mockClear()
    for (const fn of Object.values(mocks.canvas)) fn.mockReset()
    for (const fn of Object.values(mocks.folder)) fn.mockReset()
    mocks.canvas.update.mockResolvedValue({})
    mocks.folder.move.mockResolvedValue({ folder: null })
    setData([])
  })

  it('moves a canvas into a folder on drop', async () => {
    setData([canvas({ id: 'c1', title: 'Alpha' })], [folder('Work')])
    renderTree()
    await rowsRendered()

    const transfer = makeDataTransfer()
    fireEvent.dragStart(rowFor('Alpha'), { dataTransfer: transfer })
    expect(transfer.getData(CANVAS_TREE_DRAG_MIME)).toBe(
      JSON.stringify({ tree: 'canvas', kind: 'canvas', id: 'c1' })
    )

    // The drop is legal only if `dragover` was cancelled — dispatchEvent returns
    // false exactly then. Asserted while the payload is unreadable, because that
    // is the state the pointer actually moves in.
    transfer.protectedRead = true
    const target = rowFor('Work')
    expect(fireEvent.dragOver(target, { dataTransfer: transfer })).toBe(false)
    expect(within(target).getByTestId('canvas-drop-indicator')).toBeInTheDocument()

    transfer.protectedRead = false
    fireEvent.drop(target, { dataTransfer: transfer })

    await waitFor(() =>
      expect(mocks.canvas.update).toHaveBeenCalledWith({ id: 'c1', folder: 'Work' })
    )
    expect(screen.queryByTestId('canvas-drop-indicator')).not.toBeInTheDocument()
  })

  it('moves a canvas back to the root', async () => {
    localStorage.setItem('sidebar-canvas-tree-expanded', JSON.stringify(['Work']))
    setData([canvas({ id: 'c2', title: 'Beta', folder: 'Work' })], [folder('Work')])
    renderTree()
    await rowsRendered()

    const transfer = makeDataTransfer()
    fireEvent.dragStart(rowFor('Beta'), { dataTransfer: transfer })

    transfer.protectedRead = true
    const zone = rootDropZone()
    expect(fireEvent.dragOver(zone, { dataTransfer: transfer })).toBe(false)
    expect(within(zone).getByTestId('canvas-drop-indicator')).toBeInTheDocument()

    transfer.protectedRead = false
    fireEvent.drop(zone, { dataTransfer: transfer })

    await waitFor(() =>
      expect(mocks.canvas.update).toHaveBeenCalledWith({ id: 'c2', folder: null })
    )
  })

  it('moves a folder under another folder', async () => {
    setData([], [folder('Personal'), folder('Work')])
    renderTree()
    await rowsRendered()

    const transfer = makeDataTransfer()
    fireEvent.dragStart(rowFor('Personal'), { dataTransfer: transfer })
    // The payload carries what `canDrop` and the drop handler cannot look up on
    // their own: how deep the subtree riding along is, and whether a row exists.
    expect(transfer.getData(CANVAS_TREE_DRAG_MIME)).toBe(
      JSON.stringify({
        tree: 'canvas',
        kind: 'folder',
        path: 'Personal',
        subtreeDepth: 0,
        materialized: false
      })
    )

    transfer.protectedRead = true
    const target = rowFor('Work')
    expect(fireEvent.dragOver(target, { dataTransfer: transfer })).toBe(false)

    transfer.protectedRead = false
    fireEvent.drop(target, { dataTransfer: transfer })

    await waitFor(() =>
      expect(mocks.folder.move).toHaveBeenCalledWith({ path: 'Personal', parent: 'Work' })
    )
  })

  it('rejects dropping a folder into its own descendant', async () => {
    localStorage.setItem('sidebar-canvas-tree-expanded', JSON.stringify(['Work']))
    setData([], [folder('Work'), folder('Work/Q3')])
    renderTree()
    await rowsRendered()

    const transfer = makeDataTransfer()
    fireEvent.dragStart(rowFor('Work'), { dataTransfer: transfer })

    transfer.protectedRead = true
    const target = rowFor('Q3')
    // Not cancelled: the browser shows a "no drop" cursor and never fires `drop`.
    expect(fireEvent.dragOver(target, { dataTransfer: transfer })).toBe(true)
    expect(within(target).queryByTestId('canvas-drop-indicator')).not.toBeInTheDocument()

    // The drop is fired anyway: the guard must hold on its own, not because the
    // browser happened to withhold the event.
    transfer.protectedRead = false
    fireEvent.drop(target, { dataTransfer: transfer })

    await waitFor(() => expect(mocks.folder.list).toHaveBeenCalled())
    expectNothingMoved()
  })

  it('refuses a folder drop that would nest the folder past the depth cap', async () => {
    // MAX_CANVAS_FOLDER_DEPTH is 8. `d7` is the last legal landing place for a
    // childless folder; `d8` would put it at 9, which the store refuses — so
    // offering the drop would draw an indicator over a target that does nothing.
    const chain = Array.from({ length: 8 }, (_, index) => `d${index + 1}`)
    localStorage.setItem(
      'sidebar-canvas-tree-expanded',
      JSON.stringify(chain.map((_, index) => chain.slice(0, index + 1).join('/')))
    )
    setData([], [folder('Work'), folder(chain.join('/'))])
    renderTree()
    await rowsRendered()

    const transfer = makeDataTransfer()
    fireEvent.dragStart(rowFor('Work'), { dataTransfer: transfer })

    transfer.protectedRead = true
    // The boundary from below: landing at exactly the cap is still offered.
    const legal = rowFor('d7')
    expect(fireEvent.dragOver(legal, { dataTransfer: transfer })).toBe(false)
    expect(within(legal).getByTestId('canvas-drop-indicator')).toBeInTheDocument()

    const target = rowFor('d8')
    expect(fireEvent.dragOver(target, { dataTransfer: transfer })).toBe(true)
    expect(within(target).queryByTestId('canvas-drop-indicator')).not.toBeInTheDocument()

    // Fired anyway: the guard must hold on its own, not because the browser
    // happened to withhold the event.
    transfer.protectedRead = false
    fireEvent.drop(target, { dataTransfer: transfer })

    await waitFor(() => expect(mocks.folder.list).toHaveBeenCalled())
    expectNothingMoved()
  })

  it('judges the depth cap by the deepest child riding along', async () => {
    // `Work` itself would land legally under `d6` (depth 7), but `Work/Q3/Week1`
    // would land at 9 and `relocateFolder` caps every descendant it rewrites.
    const chain = Array.from({ length: 6 }, (_, index) => `d${index + 1}`)
    localStorage.setItem(
      'sidebar-canvas-tree-expanded',
      JSON.stringify(chain.map((_, index) => chain.slice(0, index + 1).join('/')))
    )
    setData(
      [canvas({ id: 'c1', title: 'Alpha', folder: 'Work/Q3/Week1' })],
      [folder(chain.join('/'))]
    )
    renderTree()
    await rowsRendered()

    const transfer = makeDataTransfer()
    fireEvent.dragStart(rowFor('Work'), { dataTransfer: transfer })

    transfer.protectedRead = true
    const target = rowFor('d6')
    expect(fireEvent.dragOver(target, { dataTransfer: transfer })).toBe(true)
    expect(within(target).queryByTestId('canvas-drop-indicator')).not.toBeInTheDocument()

    transfer.protectedRead = false
    fireEvent.drop(target, { dataTransfer: transfer })

    await waitFor(() => expect(mocks.folder.list).toHaveBeenCalled())
    expectNothingMoved()
  })

  it('creates the missing row before moving a materialized folder', async () => {
    // `Work` exists only because the canvas inside it names it. `moveCanvasFolder`
    // resolves the row first, so this drop used to land on nothing.
    setData([canvas({ id: 'c1', title: 'Alpha', folder: 'Work' })], [folder('Personal')])
    mocks.folder.create.mockResolvedValue({
      folder: { id: 'cvf_work', path: 'Work', icon: null, createdAt: 1, updatedAt: 1 }
    })
    renderTree()
    await rowsRendered()

    const transfer = makeDataTransfer()
    fireEvent.dragStart(rowFor('Work'), { dataTransfer: transfer })

    transfer.protectedRead = false
    fireEvent.drop(rowFor('Personal'), { dataTransfer: transfer })

    await waitFor(() =>
      expect(mocks.folder.move).toHaveBeenCalledWith({ path: 'Work', parent: 'Personal' })
    )
    expect(mocks.folder.create).toHaveBeenCalledWith({ parent: null, name: 'Work' })
    expect(mocks.folder.create.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.folder.move.mock.invocationCallOrder[0]
    )
  })

  it('ignores a drag payload from the notes tree', async () => {
    setData([canvas({ id: 'c1', title: 'Alpha' })], [folder('Work')])
    renderTree()
    await rowsRendered()

    // A canvas drag that ended without a `dragend` — cancelled outside the
    // window — leaves a payload remembered. What decides the next drag is the
    // TYPE it carries, never that memory.
    const abandoned = makeDataTransfer()
    fireEvent.dragStart(rowFor('Alpha'), { dataTransfer: abandoned })

    // A real note drag: the notes tree's own types, and none of ours.
    const note = makeDataTransfer({
      'text/plain': 'note-1',
      [MEMRY_NOTE_DRAG_MIME]: 'note-1'
    })
    const target = rowFor('Work')
    expect(fireEvent.dragOver(target, { dataTransfer: note })).toBe(true)
    expect(within(target).queryByTestId('canvas-drop-indicator')).not.toBeInTheDocument()
    fireEvent.drop(target, { dataTransfer: note })

    // And a payload wearing our type but tagged with another tree.
    const spoofed = makeDataTransfer({
      [CANVAS_TREE_DRAG_MIME]: JSON.stringify({ tree: 'notes', kind: 'canvas', id: 'note-1' })
    })
    expect(fireEvent.dragOver(target, { dataTransfer: spoofed })).toBe(true)
    fireEvent.drop(target, { dataTransfer: spoofed })
    fireEvent.drop(rootDropZone(), { dataTransfer: spoofed })

    await waitFor(() => expect(mocks.folder.list).toHaveBeenCalled())
    expectNothingMoved()
  })

  it('never tags a drag with the types the notes tree reads', async () => {
    setData([
      canvas({ id: 'c1', title: 'Alpha' }),
      canvas({ id: 'c9', title: 'Broken', unreadable: true })
    ])
    renderTree()
    await rowsRendered()

    const transfer = makeDataTransfer()
    fireEvent.dragStart(rowFor('Alpha'), { dataTransfer: transfer })

    // The notes tree resolves a drop from `text/plain` / the note type. Writing
    // neither is what makes a canvas dropped on the notes tree a no-op.
    expect(transfer.types).toEqual([CANVAS_TREE_DRAG_MIME])
    expect(transfer.getData('text/plain')).toBe('')
    expect(transfer.getData(MEMRY_NOTE_DRAG_MIME)).toBe('')

    // A canvas whose document cannot be read has nowhere to be moved to.
    expect(rowFor('Broken')).toHaveAttribute('draggable', 'false')
    expect(rowFor('Alpha')).toHaveAttribute('draggable', 'true')
  })
})
