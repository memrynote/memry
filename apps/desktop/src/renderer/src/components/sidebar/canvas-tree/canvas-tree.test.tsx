import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasTree, type CanvasTreeActions } from './canvas-tree'
import { SidebarProvider } from '@/components/ui/sidebar'
import type { CanvasSummary } from '@/services/canvas-service'
import type { CanvasFolder } from '@/services/canvas-folder-service'
import { isRevealed } from '@tests/utils/reveal'

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
  subscriptions: [] as Array<() => void>,
  /** The folder-updated listeners on their own, so a rename can carry a payload. */
  folderUpdated: [] as Array<(event: unknown) => void>,
  unsubscribe: vi.fn(),
  toastError: vi.fn()
}))

// `t` returns the key's last segment so assertions read like the label, and
// appends the interpolated count so a count-bearing string stays observable.
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
  onCanvasCreated: (cb: () => void) => {
    mocks.subscriptions.push(cb)
    return mocks.unsubscribe
  },
  onCanvasUpdated: (cb: () => void) => {
    mocks.subscriptions.push(cb)
    return mocks.unsubscribe
  },
  onCanvasDeleted: (cb: () => void) => {
    mocks.subscriptions.push(cb)
    return mocks.unsubscribe
  }
}))

vi.mock('@/services/canvas-folder-service', () => ({
  canvasFolderService: mocks.folder,
  onCanvasFolderCreated: (cb: () => void) => {
    mocks.subscriptions.push(cb)
    return mocks.unsubscribe
  },
  onCanvasFolderUpdated: (cb: (event: unknown) => void) => {
    mocks.subscriptions.push(cb as () => void)
    mocks.folderUpdated.push(cb)
    return mocks.unsubscribe
  },
  onCanvasFolderDeleted: (cb: () => void) => {
    mocks.subscriptions.push(cb)
    return mocks.unsubscribe
  }
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ isActiveItem: () => false })
}))

// The real item talks to window.api.bookmarks; what this suite needs to prove
// is only that the row hands it the canvas identity.
vi.mock('@/components/sidebar/bookmark-menu-item', () => ({
  BookmarkMenuItem: ({ itemType, itemId }: { itemType: string; itemId: string }) => (
    <div data-testid="bookmark-item" data-item-type={itemType} data-item-id={itemId} />
  )
}))

// The real button opens an emoji popover. What the tree owes the user is the
// call that follows the pick, so the seam is reduced to a button that makes one.
vi.mock('@/components/folder-icon-button', () => ({
  FolderIconButton: ({ onIconChange }: { onIconChange: (icon: string | null) => void }) => (
    <button type="button" data-testid="folder-icon" onClick={() => onIconChange('📌')} />
  )
}))

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

function folder(path: string, icon: string | null = null): CanvasFolder {
  return { id: `cvf_${path.toLowerCase()}`, path, icon, createdAt: 1, updatedAt: 1 }
}

function setData(canvases: CanvasSummary[], folders: CanvasFolder[] = []): void {
  mocks.canvas.list.mockResolvedValue({ canvases })
  mocks.folder.list.mockResolvedValue({ folders })
}

function renderTree(props: Partial<React.ComponentProps<typeof CanvasTree>> = {}) {
  return render(
    <SidebarProvider>
      <CanvasTree {...props} />
    </SidebarProvider>
  )
}

async function rowsRendered(): Promise<HTMLElement[]> {
  await waitFor(() => expect(screen.getAllByTestId('canvas-tree-row').length).toBeGreaterThan(0))
  return screen.getAllByTestId('canvas-tree-row')
}

function openRowMenu(label: string): HTMLElement {
  const row = screen.getByText(label).closest('[data-testid="canvas-tree-row"]')
  fireEvent.contextMenu(row as HTMLElement)
  return screen.getByTestId('canvas-tree-menu')
}

describe('CanvasTree', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.subscriptions.length = 0
    mocks.folderUpdated.length = 0
    mocks.unsubscribe.mockClear()
    mocks.toastError.mockClear()
    for (const fn of Object.values(mocks.canvas)) fn.mockReset()
    for (const fn of Object.values(mocks.folder)) fn.mockReset()
    mocks.canvas.update.mockResolvedValue({})
    mocks.canvas.delete.mockResolvedValue({ success: true })
    mocks.canvas.duplicate.mockResolvedValue(null)
    mocks.canvas.revealInFinder.mockResolvedValue(undefined)
    mocks.canvas.openExternal.mockResolvedValue(undefined)
    mocks.folder.create.mockResolvedValue({ folder: null })
    mocks.folder.rename.mockResolvedValue({ folder: null })
    mocks.folder.delete.mockResolvedValue({ success: true, deletedCanvasIds: [] })
    mocks.folder.setIcon.mockResolvedValue({ folder: null })
    setData([])
  })

  it('shows the loading, error and empty states', async () => {
    setData([])
    const empty = renderTree()
    expect(screen.getByText('loading')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('empty')).toBeInTheDocument())
    empty.unmount()

    mocks.canvas.list.mockRejectedValue(new Error('ipc down'))
    renderTree()
    await waitFor(() => expect(screen.getByText('loadFailed')).toBeInTheDocument())
  })

  it('renders folders before canvases', async () => {
    setData(
      [canvas({ id: 'c1', title: 'Alpha' }), canvas({ id: 'c2', title: 'Beta', folder: 'Work' })],
      [folder('Work')]
    )

    renderTree()
    const rows = await rowsRendered()

    // Keyed rather than by text: a collapsed folder row also carries its count.
    expect(rows.map((row) => row.dataset.rowKey)).toEqual(['folder:Work', 'canvas:c1'])
  })

  it('reveals a row menu button on keyboard focus, not only on hover', async () => {
    // The "⋯" button is the only keyboard path into a row's actions, so it
    // cannot be a hover-only control (WCAG 2.4.7). Guards the reveal against a
    // future className tidy-up dropping it.
    setData([canvas({ id: 'c1', title: 'Alpha' })])
    renderTree()
    await rowsRendered()

    const actions = screen.getByTestId('canvas-row-actions')
    expect(actions.tabIndex).toBeGreaterThanOrEqual(0)
    expect(isRevealed(actions)).toBe(false)

    act(() => actions.focus())

    expect(actions).toHaveFocus()
    expect(isRevealed(actions)).toBe(true)
  })

  it('renames a canvas through the context menu', async () => {
    setData([canvas({ id: 'c1', title: 'Alpha' })])
    renderTree()
    await rowsRendered()

    const menu = openRowMenu('Alpha')
    fireEvent.click(within(menu).getByText('rename'))

    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'save' }))

    await waitFor(() => {
      expect(mocks.canvas.update).toHaveBeenCalledWith({ id: 'c1', title: 'Renamed' })
    })
  })

  it('deletes only after the confirmation is accepted', async () => {
    setData([canvas({ id: 'c1', title: 'Alpha' })])
    renderTree()
    await rowsRendered()

    const menu = openRowMenu('Alpha')
    fireEvent.click(within(menu).getByText('delete'))

    const dialog = await screen.findByRole('alertdialog')
    expect(mocks.canvas.delete).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'delete' }))
    await waitFor(() => expect(mocks.canvas.delete).toHaveBeenCalledWith('c1'))
  })

  it('moves a canvas via the Move to folder submenu', async () => {
    setData([canvas({ id: 'c1', title: 'Alpha' })], [folder('Work')])
    renderTree()
    await rowsRendered()

    const menu = openRowMenu('Alpha')
    fireEvent.click(within(menu).getByText('moveToFolder'))

    const submenu = await screen.findByTestId('canvas-move-menu')
    // The canvas already sits at the root, so Root must be inert.
    fireEvent.click(within(submenu).getByText('moveToRoot'))
    expect(mocks.canvas.update).not.toHaveBeenCalled()

    fireEvent.click(within(submenu).getByText('Work'))
    await waitFor(() => {
      expect(mocks.canvas.update).toHaveBeenCalledWith({ id: 'c1', folder: 'Work' })
    })
  })

  it('shows an unreadable canvas as degraded with a restricted menu', async () => {
    setData([canvas({ id: 'c1', title: 'Broken', unreadable: true })])
    renderTree()
    await rowsRendered()

    expect(screen.getByTitle('unreadable')).toBeInTheDocument()
    // No icon picker: an unreadable document has nothing to decorate.
    expect(screen.queryByLabelText('setIcon')).not.toBeInTheDocument()

    const menu = openRowMenu('Broken')
    expect(within(menu).getByText('revealInFinder')).toBeInTheDocument()
    expect(within(menu).getByText('delete')).toBeInTheDocument()
    for (const hidden of ['rename', 'duplicate', 'moveToFolder', 'openExternal', 'setIcon']) {
      expect(within(menu).queryByText(hidden)).not.toBeInTheDocument()
    }
    expect(within(menu).queryByTestId('bookmark-item')).not.toBeInTheDocument()
  })

  it('bookmarks a canvas', async () => {
    setData([canvas({ id: 'c1', title: 'Alpha' })])
    renderTree()
    await rowsRendered()

    const item = within(openRowMenu('Alpha')).getByTestId('bookmark-item')
    expect(item).toHaveAttribute('data-item-type', 'canvas')
    expect(item).toHaveAttribute('data-item-id', 'c1')
  })

  it('states how many canvases a folder holds before deleting it', async () => {
    setData(
      [
        canvas({ id: 'c1', title: 'Alpha', folder: 'Work' }),
        canvas({ id: 'c2', title: 'Beta', folder: 'Work/Q3' }),
        canvas({ id: 'c3', title: 'Gamma' })
      ],
      [folder('Work')]
    )
    renderTree()
    await rowsRendered()

    const menu = openRowMenu('Work')
    fireEvent.click(within(menu).getByText('delete'))

    const dialog = await screen.findByRole('alertdialog')
    // Both the direct child and the one nested a level down count.
    expect(within(dialog).getByText(/deleteFolderConfirmBody:2/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'delete' }))
    await waitFor(() => expect(mocks.folder.delete).toHaveBeenCalledWith({ path: 'Work' }))
  })

  it('persists folder expansion per path', async () => {
    setData([canvas({ id: 'c1', title: 'Beta', folder: 'Work' })], [folder('Work')])
    const first = renderTree()
    await rowsRendered()

    expect(screen.queryByText('Beta')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Work'))
    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument())
    expect(localStorage.getItem('sidebar-canvas-tree-expanded')).toContain('Work')

    first.unmount()
    renderTree()
    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument())
  })

  it('surfaces a typed folder failure as its translated message', async () => {
    setData([], [folder('Work')])
    mocks.folder.create.mockRejectedValue(new Error('errors:canvasFolder.exists'))
    renderTree()
    await rowsRendered()

    const menu = openRowMenu('Work')
    fireEvent.click(within(menu).getByText('newFolder'))

    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Q3' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'save' }))

    await waitFor(() => {
      expect(mocks.folder.create).toHaveBeenCalledWith({ parent: 'Work', name: 'Q3' })
      // The whole chain: CanvasFolderErrorCode.EXISTS → the `errors:` key the
      // IPC layer sends → the sentence extractErrorMessage resolves it to.
      expect(mocks.toastError).toHaveBeenCalledWith(
        'A canvas folder with that name already exists here.'
      )
    })
    // A rejected name is worth keeping on screen to fix.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('creates a canvas inside the folder it was asked from', async () => {
    setData([], [folder('Work')])
    mocks.canvas.create.mockResolvedValue({ id: 'c9', title: null, folder: 'Work' })
    const onCanvasClick = vi.fn()
    renderTree({ onCanvasClick })
    await rowsRendered()

    fireEvent.click(within(openRowMenu('Work')).getByText('newCanvasHere'))

    await waitFor(() => {
      expect(mocks.canvas.create).toHaveBeenCalledWith({ folder: 'Work' })
      expect(onCanvasClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'c9' }))
    })
  })

  it('refreshes on all six events and unsubscribes on unmount', async () => {
    setData([])
    const { unmount } = renderTree()
    await waitFor(() => expect(screen.getByText('empty')).toBeInTheDocument())
    expect(mocks.subscriptions).toHaveLength(6)

    setData([canvas({ id: 'c1', title: 'Fresh' })])
    mocks.subscriptions.forEach((cb) => cb())
    await waitFor(() => expect(screen.getByText('Fresh')).toBeInTheDocument())

    unmount()
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(6)
  })

  describe('materialized folders', () => {
    /** Both mocks were called, and `create` came first. */
    function expectMaterializedBefore(mutation: ReturnType<typeof vi.fn>): void {
      expect(mocks.folder.create).toHaveBeenCalledTimes(1)
      expect(mutation).toHaveBeenCalledTimes(1)
      expect(mocks.folder.create.mock.invocationCallOrder[0]).toBeLessThan(
        mutation.mock.invocationCallOrder[0]
      )
    }

    it('creates the missing row before renaming a folder that has none', async () => {
      // `Work` is named only by the canvas filed inside it: no canvas_folders
      // row backs it, and `renameCanvasFolder` resolves the row first, so this
      // rename used to return null and change nothing.
      setData([canvas({ id: 'c1', title: 'Alpha', folder: 'Work' })], [])
      mocks.folder.create.mockResolvedValue({ folder: folder('Work') })
      renderTree()
      await rowsRendered()

      fireEvent.click(within(openRowMenu('Work')).getByText('rename'))
      const dialog = await screen.findByRole('dialog')
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Studio' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'save' }))

      await waitFor(() => {
        expect(mocks.folder.rename).toHaveBeenCalledWith({ path: 'Work', name: 'Studio' })
      })
      expect(mocks.folder.create).toHaveBeenCalledWith({ parent: null, name: 'Work' })
      expectMaterializedBefore(mocks.folder.rename)
    })

    it('creates the missing row before setting an icon, naming the parent', async () => {
      localStorage.setItem('sidebar-canvas-tree-expanded', JSON.stringify(['Work']))
      setData([canvas({ id: 'c1', title: 'Alpha', folder: 'Work/Q3' })], [])
      mocks.folder.create.mockResolvedValue({ folder: folder('Work/Q3') })
      renderTree()
      await rowsRendered()

      const row = screen.getByText('Q3').closest('[data-testid="canvas-tree-row"]') as HTMLElement
      fireEvent.click(within(row).getByTestId('folder-icon'))

      await waitFor(() => {
        expect(mocks.folder.setIcon).toHaveBeenCalledWith({ path: 'Work/Q3', icon: '📌' })
      })
      expect(mocks.folder.create).toHaveBeenCalledWith({ parent: 'Work', name: 'Q3' })
      expectMaterializedBefore(mocks.folder.setIcon)
    })

    it('creates the missing row before deleting a folder that has none', async () => {
      // A delete with no row behind it tombstones the canvases and nothing
      // else: the folder survives on whichever device owns its row and syncs
      // straight back, so the user deletes a folder and it returns, empty.
      setData([canvas({ id: 'c1', title: 'Alpha', folder: 'Work' })], [])
      mocks.folder.create.mockResolvedValue({ folder: folder('Work') })
      renderTree()
      await rowsRendered()

      fireEvent.click(within(openRowMenu('Work')).getByText('delete'))
      const dialog = await screen.findByRole('alertdialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'delete' }))

      await waitFor(() => {
        expect(mocks.folder.delete).toHaveBeenCalledWith({ path: 'Work' })
      })
      expect(mocks.folder.create).toHaveBeenCalledWith({ parent: null, name: 'Work' })
      expectMaterializedBefore(mocks.folder.delete)
    })

    it('does not mint a row for a folder that already has one', async () => {
      setData([], [folder('Work')])
      renderTree()
      await rowsRendered()

      fireEvent.click(within(openRowMenu('Work')).getByText('rename'))
      const dialog = await screen.findByRole('dialog')
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Studio' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'save' }))

      await waitFor(() => {
        expect(mocks.folder.rename).toHaveBeenCalledWith({ path: 'Work', name: 'Studio' })
      })
      expect(mocks.folder.create).not.toHaveBeenCalled()
    })

    it('does not run the mutation when the row could not be minted', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha', folder: 'Work' })], [])
      mocks.folder.create.mockRejectedValue(new Error('errors:canvasFolder.exists'))
      renderTree()
      await rowsRendered()

      fireEvent.click(within(openRowMenu('Work')).getByText('rename'))
      const dialog = await screen.findByRole('dialog')
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Studio' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'save' }))

      await waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
      expect(mocks.folder.rename).not.toHaveBeenCalled()
    })
  })

  describe('filtering', () => {
    /** Three canvases across two folders — enough to filter something out. */
    function setFilterData(): void {
      setData(
        [
          canvas({ id: 'c1', title: 'Alpha' }),
          canvas({ id: 'c2', title: 'Roadmap', folder: 'Work' }),
          canvas({ id: 'c3', title: 'Groceries', folder: 'Personal' })
        ],
        [folder('Work'), folder('Personal')]
      )
    }

    function typeFilter(value: string): void {
      fireEvent.change(screen.getByLabelText('filterPlaceholder'), { target: { value } })
    }

    it('stays out of the way until the vault has enough canvases', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' })])
      const small = renderTree({ filterThreshold: 2 })
      await rowsRendered()
      expect(screen.queryByLabelText('filterPlaceholder')).not.toBeInTheDocument()
      small.unmount()

      setFilterData()
      renderTree({ filterThreshold: 2 })
      await rowsRendered()
      expect(screen.getByLabelText('filterPlaceholder')).toBeInTheDocument()
    })

    it('keeps a matching canvas visible and opens the folder holding it', async () => {
      setFilterData()
      renderTree({ filterThreshold: 2 })
      await rowsRendered()
      // Nothing is expanded, so the match is inside a closed folder.
      expect(screen.queryByText('Roadmap')).not.toBeInTheDocument()

      typeFilter('roadmap')

      await waitFor(() => expect(screen.getByText('Roadmap')).toBeInTheDocument())
      expect(screen.getByText('Work')).toBeInTheDocument()
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
      expect(screen.queryByText('Personal')).not.toBeInTheDocument()
    })

    it('matches on the folder path too, keeping everything inside it', async () => {
      setFilterData()
      renderTree({ filterThreshold: 2 })
      await rowsRendered()

      typeFilter('personal')

      await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument())
      expect(screen.queryByText('Work')).not.toBeInTheDocument()
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    })

    it('says so when nothing matches, without taking the input away', async () => {
      setFilterData()
      renderTree({ filterThreshold: 2 })
      await rowsRendered()

      typeFilter('zzz')

      await waitFor(() => expect(screen.getByText('filterNoMatches')).toBeInTheDocument())
      expect(screen.getByLabelText('filterPlaceholder')).toBeInTheDocument()
    })

    it('restores the expansion the user had, rather than collapsing everything', async () => {
      // Personal is open before the filter runs; Work is not.
      localStorage.setItem('sidebar-canvas-tree-expanded', JSON.stringify(['Personal']))
      setFilterData()
      renderTree({ filterThreshold: 2 })
      await rowsRendered()
      expect(screen.getByText('Groceries')).toBeInTheDocument()

      // Filtering opens Work — but that must not be mistaken for the user's own
      // expansion state, nor persisted as it.
      typeFilter('roadmap')
      await waitFor(() => expect(screen.getByText('Roadmap')).toBeInTheDocument())
      expect(localStorage.getItem('sidebar-canvas-tree-expanded')).not.toContain('Work')

      typeFilter('')

      await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument())
      expect(screen.queryByText('Roadmap')).not.toBeInTheDocument()
    })
  })

  it('states how many canvases a collapsed folder holds, at any depth', async () => {
    setData(
      [
        canvas({ id: 'c1', title: 'Alpha', folder: 'Work' }),
        canvas({ id: 'c2', title: 'Beta', folder: 'Work/Q3' }),
        canvas({ id: 'c3', title: 'Gamma' })
      ],
      [folder('Work')]
    )
    renderTree()
    await rowsRendered()

    const rowOf = (label: string): HTMLElement =>
      screen.getByText(label).closest('[data-testid="canvas-tree-row"]') as HTMLElement

    // Two levels down still counts.
    expect(within(rowOf('Work')).getByTestId('canvas-folder-count')).toHaveTextContent('2')

    // Expanded, the rows themselves say it; a badge would be a second answer.
    fireEvent.click(screen.getByText('Work'))
    await waitFor(() => expect(screen.getByText('Q3')).toBeInTheDocument())
    expect(within(rowOf('Work')).queryByTestId('canvas-folder-count')).not.toBeInTheDocument()
    // The nested folder is still closed, so it states its own.
    expect(within(rowOf('Q3')).getByTestId('canvas-folder-count')).toHaveTextContent('1')
  })

  it('offers a way out of an expanded folder that holds nothing', async () => {
    setData([], [folder('Work')])
    mocks.canvas.create.mockResolvedValue({ id: 'c9', title: null, folder: 'Work' })
    renderTree()
    await rowsRendered()

    expect(screen.queryByTestId('canvas-folder-empty')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Work'))

    const empty = await screen.findByTestId('canvas-folder-empty')
    fireEvent.click(within(empty).getByText('newCanvasHere'))

    await waitFor(() => expect(mocks.canvas.create).toHaveBeenCalledWith({ folder: 'Work' }))
  })

  it('keeps a renamed folder expanded by re-keying its stored expansion', async () => {
    setData([canvas({ id: 'c1', title: 'Beta', folder: 'Work' })], [folder('Work')])
    renderTree()
    await rowsRendered()

    fireEvent.click(screen.getByText('Work'))
    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument())

    // What the main process emits after `canvasFolder:rename`.
    setData([canvas({ id: 'c1', title: 'Beta', folder: 'Studio' })], [folder('Studio')])
    mocks.folderUpdated.forEach((cb) => cb({ folder: folder('Studio'), previousPath: 'Work' }))

    await waitFor(() => expect(screen.getByText('Studio')).toBeInTheDocument())
    // Expansion is keyed by path: without re-keying, the folder the user just
    // renamed would shut itself — and stay shut across restarts.
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(localStorage.getItem('sidebar-canvas-tree-expanded')).toContain('Studio')
  })

  describe('creating a folder at the root', () => {
    /** Types `name` into the open name dialog and saves it. */
    async function submitName(name: string): Promise<void> {
      const dialog = await screen.findByRole('dialog')
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: name } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'save' }))
    }

    it('offers it from the empty state, so a vault with nothing is not a dead end', async () => {
      setData([], [])
      mocks.folder.create.mockResolvedValue({ folder: folder('Work') })
      renderTree()
      await waitFor(() => expect(screen.getByText('empty')).toBeInTheDocument())

      fireEvent.click(screen.getByRole('button', { name: 'newFolder' }))
      await submitName('Work')

      await waitFor(() =>
        expect(mocks.folder.create).toHaveBeenCalledWith({ parent: null, name: 'Work' })
      )
    })

    it('offers a new canvas from the empty state too', async () => {
      setData([], [])
      mocks.canvas.create.mockResolvedValue({ id: 'c9', title: null, folder: null })
      const onCanvasClick = vi.fn()
      renderTree({ onCanvasClick })
      await waitFor(() => expect(screen.getByText('empty')).toBeInTheDocument())

      fireEvent.click(screen.getByRole('button', { name: 'newCanvas' }))

      await waitFor(() => expect(mocks.canvas.create).toHaveBeenCalledWith({ folder: null }))
    })

    it('exposes a root-level createFolder to its host', async () => {
      // The host's section header sits OUTSIDE the tree, and a folder row's own
      // menu can only ever create a CHILD — so without this handle the root is
      // unreachable however many folders already exist.
      setData([], [folder('Work')])
      mocks.folder.create.mockResolvedValue({ folder: folder('Personal') })
      const ref: { current: CanvasTreeActions | null } = { current: null }
      render(
        <SidebarProvider>
          <CanvasTree ref={ref} />
        </SidebarProvider>
      )
      await rowsRendered()

      await act(async () => {
        ref.current?.createFolder()
      })
      await submitName('Personal')

      await waitFor(() =>
        expect(mocks.folder.create).toHaveBeenCalledWith({ parent: null, name: 'Personal' })
      )
    })
  })

  describe('moving a folder from its own menu', () => {
    /** Work holds Q3; Personal is a sibling. Enough to exercise every rule. */
    function setMoveData(): void {
      setData(
        [canvas({ id: 'c1', title: 'Alpha', folder: 'Work/Q3' })],
        [folder('Work'), folder('Work/Q3'), folder('Personal')]
      )
    }

    it('lists Root and every other folder, never itself or its own descendants', async () => {
      setMoveData()
      renderTree()
      await rowsRendered()

      fireEvent.click(within(openRowMenu('Work')).getByText('moveToFolder'))
      const submenu = await screen.findByTestId('canvas-folder-move-menu')

      expect(within(submenu).getByText('moveToRoot')).toBeInTheDocument()
      expect(within(submenu).getByText('Personal')).toBeInTheDocument()
      // A folder cannot move into itself, nor into its own subtree.
      expect(within(submenu).queryByText('Work')).not.toBeInTheDocument()
      expect(within(submenu).queryByText('Q3')).not.toBeInTheDocument()
    })

    it('moves the folder into the chosen target', async () => {
      setMoveData()
      mocks.folder.move.mockResolvedValue({ folder: null })
      renderTree()
      await rowsRendered()

      fireEvent.click(within(openRowMenu('Work')).getByText('moveToFolder'))
      const submenu = await screen.findByTestId('canvas-folder-move-menu')

      // Work already sits at the root, so Root must be inert.
      fireEvent.click(within(submenu).getByText('moveToRoot'))
      expect(mocks.folder.move).not.toHaveBeenCalled()

      fireEvent.click(within(submenu).getByText('Personal'))
      await waitFor(() =>
        expect(mocks.folder.move).toHaveBeenCalledWith({ path: 'Work', parent: 'Personal' })
      )
    })

    it('mints the row first for a folder that has none', async () => {
      // `Work` is named only by the canvas inside it, so `moveCanvasFolder`
      // would resolve no row and silently do nothing.
      setData([canvas({ id: 'c1', title: 'Alpha', folder: 'Work' })], [folder('Personal')])
      mocks.folder.create.mockResolvedValue({ folder: folder('Work') })
      mocks.folder.move.mockResolvedValue({ folder: null })
      renderTree()
      await rowsRendered()

      fireEvent.click(within(openRowMenu('Work')).getByText('moveToFolder'))
      const submenu = await screen.findByTestId('canvas-folder-move-menu')
      fireEvent.click(within(submenu).getByText('Personal'))

      await waitFor(() =>
        expect(mocks.folder.move).toHaveBeenCalledWith({ path: 'Work', parent: 'Personal' })
      )
      expect(mocks.folder.create).toHaveBeenCalledWith({ parent: null, name: 'Work' })
      expect(mocks.folder.create.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.folder.move.mock.invocationCallOrder[0]
      )
    })
  })

  it('states the TRUE canvas count before a delete, even while a filter hides some', async () => {
    setData(
      [
        canvas({ id: 'c1', title: 'Roadmap', folder: 'Work' }),
        canvas({ id: 'c2', title: 'Budget', folder: 'Work' }),
        canvas({ id: 'c3', title: 'Retro', folder: 'Work/Q3' })
      ],
      [folder('Work')]
    )
    renderTree({ filterThreshold: 2 })
    await rowsRendered()

    // Only one of the three survives the filter, so the FILTERED node reports 1.
    fireEvent.change(screen.getByLabelText('filterPlaceholder'), { target: { value: 'roadmap' } })
    await waitFor(() => expect(screen.getByText('Roadmap')).toBeInTheDocument())

    fireEvent.click(within(openRowMenu('Work')).getByText('delete'))

    const dialog = await screen.findByRole('alertdialog')
    // A destructive confirmation may not understate its blast radius.
    expect(within(dialog).getByText(/deleteFolderConfirmBody:3/)).toBeInTheDocument()
  })

  it('reports the canvas count to its host', async () => {
    setData([canvas({ id: 'c1', title: 'Alpha' }), canvas({ id: 'c2', title: 'Beta' })])
    const onCountChange = vi.fn()
    renderTree({ onCountChange })

    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(2))
  })

  it('reports the folder the user is looking at to its host', async () => {
    setData(
      [canvas({ id: 'c1', title: 'Alpha' }), canvas({ id: 'c2', title: 'Beta', folder: 'Work' })],
      [folder('Work')]
    )
    const onTargetFolderChange = vi.fn()
    renderTree({ onTargetFolderChange })
    await rowsRendered()

    // Touching a folder row is the user saying "here".
    fireEvent.click(screen.getByText('Work'))
    expect(onTargetFolderChange).toHaveBeenLastCalledWith('Work')

    // A canvas stands for the folder holding it, the way the notes tree's
    // selected note resolves to its parent.
    fireEvent.click(await screen.findByText('Beta'))
    expect(onTargetFolderChange).toHaveBeenLastCalledWith('Work')

    fireEvent.click(screen.getByText('Alpha'))
    expect(onTargetFolderChange).toHaveBeenLastCalledWith(null)
  })
})
