import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasTree, type CanvasTreeActions } from './canvas-tree'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TabProvider } from '@/contexts/tabs'
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

// `FolderIconButton` is deliberately NOT mocked: it wraps `IconPickerButton`,
// which is a click-propagation boundary of its own — a picker that let its
// clicks through would open or toggle the row behind it. A stub button in its
// place erases that boundary and makes the suite blind to the leak. Only the
// emoji grid itself is stubbed, because loading the real one is the one part
// that costs anything.
vi.mock('@/components/note/note-title/EmojiPicker', () => ({
  EmojiPicker: ({
    onSelect,
    onRemove
  }: {
    onSelect: (icon: string) => void
    onRemove: () => void
  }) => (
    <div data-testid="emoji-picker">
      <button type="button" data-testid="emoji-pick" onClick={() => onSelect('📌')} />
      <button type="button" data-testid="emoji-remove" onClick={onRemove} />
    </div>
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
    <TabProvider>
      <SidebarProvider>
        <CanvasTree {...props} />
      </SidebarProvider>
    </TabProvider>
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

/**
 * The row's own "⋯" dropdown — the menu that is a React CHILD of the row, and
 * therefore the one whose events can leak into it. Opened from the keyboard,
 * which is what Radix's trigger listens for.
 */
function openActionsMenu(rowLabel: string, menuLabel: string): Promise<HTMLElement> {
  const row = screen.getByText(rowLabel).closest('[data-testid="canvas-tree-row"]') as HTMLElement
  const trigger = within(row).getByLabelText(menuLabel)
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter' })
  return screen.findByTestId('canvas-row-actions-menu')
}

/** The row a node's key names, or `null` when it is not on screen. */
function rowByKey(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-row-key="${key}"]`)
}

/**
 * The inline naming field, whichever row kind owns it. Named through the row's
 * own i18n key, so the assertion also pins the accessible name.
 */
function nameField(): Promise<HTMLElement> {
  return screen.findByLabelText(/^(renameLabel|folderNameLabel)$/)
}

/** The same field, read in the tick it appeared in. */
function queryNameField(): HTMLElement | null {
  return screen.queryByLabelText(/^(renameLabel|folderNameLabel)$/)
}

/**
 * Chooses an emoji for `row`, the way the user does: open the picker from the
 * row's icon, then pick. Both clicks go through the real picker, so both of its
 * propagation boundaries are exercised.
 */
async function pickIcon(row: HTMLElement): Promise<void> {
  fireEvent.click(within(row).getByLabelText('setFolderIcon'))
  fireEvent.click(await screen.findByTestId('emoji-pick'))
}

/** Types `value` into the open field and commits it with Enter. */
async function commitName(value: string): Promise<HTMLElement> {
  const input = await nameField()
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter' })
  return input
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

  /**
   * The dropdown's content is portaled out of the row's DOM subtree, but it is
   * still a React CHILD of the row — and React synthetic events propagate
   * through the REACT tree — so choosing an item ALSO fired the row's own
   * click. Asking for Rename opened the canvas; so did asking for Duplicate.
   *
   * The same leak was already stopped for keydown; this is the click half.
   */
  describe('choosing an item from a row menu is not clicking the row', () => {
    it('does not open the canvas behind its menu', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' })])
      const onCanvasClick = vi.fn()
      renderTree({ onCanvasClick })
      await rowsRendered()

      const menu = await openActionsMenu('Alpha', 'canvasMenu')
      fireEvent.click(within(menu).getByText('duplicate'))

      await waitFor(() => expect(mocks.canvas.duplicate).toHaveBeenCalledWith('c1'))
      expect(onCanvasClick).not.toHaveBeenCalled()
    })

    it('does not open the canvas when Rename is the item chosen', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' })])
      const onCanvasClick = vi.fn()
      renderTree({ onCanvasClick })
      await rowsRendered()

      const menu = await openActionsMenu('Alpha', 'canvasMenu')
      fireEvent.click(within(menu).getByText('rename'))

      // Asserted in the same tick the click was handled in: the leak is
      // synchronous, and the field itself is transient once the menu hands
      // focus back.
      expect(queryNameField()).toBeInTheDocument()
      expect(onCanvasClick).not.toHaveBeenCalled()
    })

    it('does not toggle the folder behind its menu', async () => {
      setData([canvas({ id: 'c1', title: 'Beta', folder: 'Work' })], [folder('Work')])
      const onTargetFolderChange = vi.fn()
      renderTree({ onTargetFolderChange })
      await rowsRendered()

      const menu = await openActionsMenu('Work', 'folderMenu')
      fireEvent.click(within(menu).getByText('rename'))

      expect(queryNameField()).toBeInTheDocument()
      // A toggle would have expanded the folder and reported it as the target.
      expect(onTargetFolderChange).not.toHaveBeenCalled()
      expect(screen.queryByText('Beta')).not.toBeInTheDocument()
    })
  })

  /**
   * The icon picker is the row's OTHER propagation boundary. Its popover is
   * portaled out of the row's DOM subtree, but it stays a React CHILD of the
   * row and React synthetic events travel the REACT tree — so both opening the
   * picker and choosing from it used to be able to activate the row underneath.
   */
  it('choosing an icon is not clicking the row', async () => {
    setData([canvas({ id: 'c1', title: 'Beta', folder: 'Work' })], [folder('Work')])
    const onTargetFolderChange = vi.fn()
    renderTree({ onTargetFolderChange })
    await rowsRendered()

    const row = screen.getByText('Work').closest('[data-testid="canvas-tree-row"]') as HTMLElement
    await pickIcon(row)

    await waitFor(() =>
      expect(mocks.folder.setIcon).toHaveBeenCalledWith({ path: 'Work', icon: '📌' })
    )
    // A toggle would have expanded the folder and reported it as the target.
    expect(onTargetFolderChange).not.toHaveBeenCalled()
    expect(screen.queryByText('Beta')).not.toBeInTheDocument()
  })

  it('renames a canvas on the row itself, never in a dialog', async () => {
    setData([canvas({ id: 'c1', title: 'Alpha' })])
    renderTree()
    await rowsRendered()

    const menu = openRowMenu('Alpha')
    fireEvent.click(within(menu).getByText('rename'))

    // The field opens carrying the current name, ON the row.
    const input = await nameField()
    expect(input).toHaveValue('Alpha')
    expect(input.closest('[data-testid="canvas-tree-row"]')).not.toBeNull()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(mocks.canvas.update).toHaveBeenCalledWith({ id: 'c1', title: 'Renamed' })
    })
  })

  /**
   * A row is a drag SOURCE, and a draggable ancestor takes the press-and-move
   * gesture for a drag: the browser starts dragging the row instead of
   * extending a selection, so the user cannot sweep the caret across the name
   * they are editing, nor drag over part of it to replace it. Both row kinds
   * therefore have to let go of the drag while their field is open.
   */
  describe('a row being named stops being a drag source', () => {
    it('lets go on the folder row', async () => {
      setData([], [folder('Work')])
      renderTree()
      await rowsRendered()

      expect(rowByKey('folder:Work')).toHaveAttribute('draggable', 'true')

      fireEvent.click(within(openRowMenu('Work')).getByText('rename'))
      await nameField()

      expect(rowByKey('folder:Work')).toHaveAttribute('draggable', 'false')
    })

    it('lets go on the canvas row', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' })])
      renderTree()
      await rowsRendered()

      expect(rowByKey('canvas:c1')).toHaveAttribute('draggable', 'true')

      fireEvent.click(within(openRowMenu('Alpha')).getByText('rename'))
      await nameField()

      expect(rowByKey('canvas:c1')).toHaveAttribute('draggable', 'false')
    })
  })

  it('clicking into the field is not clicking the row', async () => {
    // The row opens the canvas on click, and the field sits inside it. Putting
    // the caret somewhere is not asking for the canvas.
    setData([canvas({ id: 'c1', title: 'Alpha' })])
    const onCanvasClick = vi.fn()
    renderTree({ onCanvasClick })
    await rowsRendered()

    fireEvent.click(within(openRowMenu('Alpha')).getByText('rename'))
    const input = await nameField()
    expect(onCanvasClick).not.toHaveBeenCalled()

    fireEvent.click(input)

    expect(onCanvasClick).not.toHaveBeenCalled()
    expect(input).toBeInTheDocument()
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

  it('surfaces a typed folder failure in the field, and keeps the user in it', async () => {
    setData([], [folder('Work'), folder('Personal')])
    mocks.folder.rename.mockRejectedValue(new Error('errors:canvasFolder.exists'))
    renderTree()
    await rowsRendered()

    fireEvent.click(within(openRowMenu('Work')).getByText('rename'))
    const input = await commitName('Personal')

    await waitFor(() => {
      expect(mocks.folder.rename).toHaveBeenCalledWith({ path: 'Work', name: 'Personal' })
      // The whole chain: CanvasFolderErrorCode.EXISTS → the `errors:` key the
      // IPC layer sends → the sentence extractErrorMessage resolves it to.
      expect(mocks.toastError).toHaveBeenCalledWith(
        'A canvas folder with that name already exists here.'
      )
    })

    // A refused name is an instruction to type another one, so the field stays
    // — with the reason beside it, not only in a toast that scrolls away.
    expect(input).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A canvas folder with that name already exists here.'
    )
    await waitFor(() => expect(input).toHaveFocus())
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

  /**
   * Creating anything is one interaction: the row is made immediately and opens
   * as a field. That only holds if the new row is actually ON SCREEN — a folder
   * left collapsed or a filter left in place puts the field somewhere the user
   * cannot see they are typing.
   */
  describe('a new row opens as a field', () => {
    /** What the main process emits once the canvas exists on disk. */
    function refreshed(canvases: CanvasSummary[], folders: CanvasFolder[]): void {
      setData(canvases, folders)
      mocks.subscriptions.forEach((cb) => cb())
    }

    it('opens the new canvas for naming, in the folder it just expanded', async () => {
      setData([], [folder('Work')])
      mocks.canvas.create.mockResolvedValue({ id: 'c9', title: null, folder: 'Work' })
      renderTree()
      await rowsRendered()

      fireEvent.click(within(openRowMenu('Work')).getByText('newCanvasHere'))
      await waitFor(() => expect(mocks.canvas.create).toHaveBeenCalledWith({ folder: 'Work' }))

      // Work was collapsed, so without the expansion the new row — and the
      // field on it — never renders at all.
      refreshed([canvas({ id: 'c9', folder: 'Work' })], [folder('Work')])

      const input = await nameField()
      expect(rowByKey('canvas:c9')).toContainElement(input)
      // Pre-filled with the label the row would otherwise show, so overtyping
      // it is the whole interaction.
      expect(input).toHaveValue('untitled')

      fireEvent.change(input, { target: { value: 'Plan' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() =>
        expect(mocks.canvas.update).toHaveBeenCalledWith({ id: 'c9', title: 'Plan' })
      )
    })

    it('clears a filter that would hide the canvas it just created', async () => {
      // Work is already open, so the filter is the only thing that could keep
      // the new row off screen.
      localStorage.setItem('sidebar-canvas-tree-expanded', JSON.stringify(['Work']))
      setData(
        [canvas({ id: 'c1', title: 'Alpha' }), canvas({ id: 'c2', title: 'Beta', folder: 'Work' })],
        [folder('Work')]
      )
      mocks.canvas.create.mockResolvedValue({ id: 'c9', title: null, folder: 'Work' })
      renderTree({ filterThreshold: 2 })
      await rowsRendered()

      fireEvent.change(screen.getByLabelText('filterPlaceholder'), { target: { value: 'beta' } })
      await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument())

      fireEvent.click(within(openRowMenu('Work')).getByText('newCanvasHere'))
      await waitFor(() => expect(mocks.canvas.create).toHaveBeenCalledWith({ folder: 'Work' }))

      refreshed(
        [
          canvas({ id: 'c1', title: 'Alpha' }),
          canvas({ id: 'c2', title: 'Beta', folder: 'Work' }),
          canvas({ id: 'c9', folder: 'Work' })
        ],
        [folder('Work')]
      )

      // An untitled canvas does not match "beta", so a filter left standing
      // leaves the user typing into a row that is not rendered.
      const input = await nameField()
      expect(rowByKey('canvas:c9')).toContainElement(input)
    })

    it('opens the new subfolder for naming, in the parent it just expanded', async () => {
      setData([], [folder('Work')])
      mocks.folder.create.mockResolvedValue({ folder: folder('Work/Untitled Folder') })
      renderTree()
      await rowsRendered()

      fireEvent.click(within(openRowMenu('Work')).getByText('newFolder'))
      await waitFor(() =>
        expect(mocks.folder.create).toHaveBeenCalledWith({
          parent: 'Work',
          name: 'Untitled Folder'
        })
      )

      refreshed([], [folder('Work'), folder('Work/Untitled Folder')])

      const input = await nameField()
      expect(rowByKey('folder:Work/Untitled Folder')).toContainElement(input)
      expect(input).toHaveValue('Untitled Folder')
    })

    it('clears a filter that would hide the folder it just created', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' }), canvas({ id: 'c2', title: 'Beta' })], [])
      mocks.folder.create.mockResolvedValue({ folder: folder('Untitled Folder') })
      const ref: { current: CanvasTreeActions | null } = { current: null }
      render(
        <SidebarProvider>
          <CanvasTree ref={ref} filterThreshold={2} />
        </SidebarProvider>
      )
      await rowsRendered()

      fireEvent.change(screen.getByLabelText('filterPlaceholder'), { target: { value: 'alpha' } })
      await waitFor(() => expect(screen.queryByText('Beta')).not.toBeInTheDocument())

      await act(async () => {
        ref.current?.createFolder()
      })
      await waitFor(() => expect(mocks.folder.create).toHaveBeenCalled())

      refreshed(
        [canvas({ id: 'c1', title: 'Alpha' }), canvas({ id: 'c2', title: 'Beta' })],
        [folder('Untitled Folder')]
      )

      // The new folder matches nothing the user typed, so the filter has to go.
      const input = await nameField()
      expect(rowByKey('folder:Untitled Folder')).toContainElement(input)
    })

    it('opens the row the store actually made, not the one it was asked for', async () => {
      // The store canonicalises a name it cannot use as a directory, so a
      // predicted path addresses a row that does not exist and the field opens
      // on nothing.
      setData([], [])
      mocks.folder.create.mockResolvedValue({ folder: folder('Untitled Folder canvas') })
      renderTree()
      await waitFor(() => expect(screen.getByText('empty')).toBeInTheDocument())

      fireEvent.click(screen.getByRole('button', { name: 'newFolder' }))
      await waitFor(() =>
        expect(mocks.folder.create).toHaveBeenCalledWith({ parent: null, name: 'Untitled Folder' })
      )

      refreshed([], [folder('Untitled Folder canvas')])

      const input = await nameField()
      expect(input).toHaveValue('Untitled Folder canvas')

      fireEvent.change(input, { target: { value: 'Work' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() =>
        expect(mocks.folder.rename).toHaveBeenCalledWith({
          path: 'Untitled Folder canvas',
          name: 'Work'
        })
      )
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
      await commitName('Studio')

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
      await pickIcon(row)

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
      await commitName('Studio')

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
      await commitName('Studio')

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

  /**
   * A rename is not a promise that the name asked for is the name given: the
   * store canonicalises anything it cannot use as a directory. A folder row's
   * key IS its path, so a predicted key addresses a row that never renders and
   * focus restoration lands nowhere — the same failure `handleNewFolder` had.
   */
  it('returns focus to the folder path the store settled on, not the name it asked for', async () => {
    setData([], [folder('Work')])
    mocks.folder.rename.mockResolvedValue({ folder: folder('CON canvas') })
    renderTree()
    await rowsRendered()

    fireEvent.click(within(openRowMenu('Work')).getByText('rename'))
    await commitName('CON')

    await waitFor(() =>
      expect(mocks.folder.rename).toHaveBeenCalledWith({ path: 'Work', name: 'CON' })
    )

    // What the main process emits once the directory exists under its real name.
    setData([], [folder('CON canvas')])
    mocks.subscriptions.forEach((cb) => cb())

    await waitFor(() => expect(rowByKey('folder:CON canvas')).not.toBeNull())
    // The row the prediction named was never rendered — nothing to focus.
    expect(rowByKey('folder:CON')).toBeNull()
    await waitFor(() =>
      expect(
        rowByKey('folder:CON canvas')?.querySelector('[data-slot="sidebar-menu-button"]')
      ).toHaveFocus()
    )
  })

  describe('creating a folder at the root', () => {
    /**
     * What the main process emits once the folder exists — the row the field is
     * waiting for does not render until this lands.
     */
    function folderArrived(...paths: string[]): void {
      setData(
        [],
        paths.map((path) => folder(path))
      )
      mocks.subscriptions.forEach((cb) => cb())
    }

    it('offers it from the empty state, so a vault with nothing is not a dead end', async () => {
      setData([], [])
      mocks.folder.create.mockResolvedValue({ folder: folder('Untitled Folder') })
      renderTree()
      await waitFor(() => expect(screen.getByText('empty')).toBeInTheDocument())

      fireEvent.click(screen.getByRole('button', { name: 'newFolder' }))

      // Created straight away under a default name — no dialog stands between
      // asking for a folder and having one.
      await waitFor(() =>
        expect(mocks.folder.create).toHaveBeenCalledWith({ parent: null, name: 'Untitled Folder' })
      )
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

      folderArrived('Untitled Folder')
      const input = await nameField()
      expect(input).toHaveValue('Untitled Folder')

      fireEvent.change(input, { target: { value: 'Work' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() =>
        expect(mocks.folder.rename).toHaveBeenCalledWith({
          path: 'Untitled Folder',
          name: 'Work'
        })
      )
    })

    it('steps the default name past the siblings that already took it', async () => {
      // Created before the user has typed anything, so the default has to be a
      // name the store will accept — otherwise a second New folder just fails.
      setData([], [folder('Untitled Folder'), folder('Untitled Folder 2')])
      mocks.folder.create.mockResolvedValue({ folder: folder('Untitled Folder 3') })
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

      await waitFor(() =>
        expect(mocks.folder.create).toHaveBeenCalledWith({
          parent: null,
          name: 'Untitled Folder 3'
        })
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
      mocks.folder.create.mockResolvedValue({ folder: folder('Untitled Folder') })
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

      await waitFor(() =>
        expect(mocks.folder.create).toHaveBeenCalledWith({ parent: null, name: 'Untitled Folder' })
      )

      folderArrived('Work', 'Untitled Folder')
      fireEvent.change(await nameField(), { target: { value: 'Personal' } })
      fireEvent.keyDown(await nameField(), { key: 'Enter' })

      await waitFor(() =>
        expect(mocks.folder.rename).toHaveBeenCalledWith({
          path: 'Untitled Folder',
          name: 'Personal'
        })
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

    /**
     * The menu is the only keyboard path to moving a folder, and the row it was
     * run from is gone the moment the move lands: a folder row's key IS its
     * path. Radix hands focus back to a trigger that went with it, so without a
     * target of its own the move ends with focus on `document.body`.
     *
     * And the target has to be the path the STORE settled on — it canonicalises
     * names it cannot use as a directory, so a predicted path names a row that
     * never renders.
     */
    it('returns focus to the folder path the store settled on after a move', async () => {
      localStorage.setItem('sidebar-canvas-tree-expanded', JSON.stringify(['Personal']))
      setData([], [folder('Work'), folder('Personal')])
      mocks.folder.move.mockResolvedValue({ folder: folder('Personal/Work canvas') })
      renderTree()
      await rowsRendered()

      fireEvent.click(within(openRowMenu('Work')).getByText('moveToFolder'))
      const submenu = await screen.findByTestId('canvas-folder-move-menu')
      fireEvent.click(within(submenu).getByText('Personal'))

      await waitFor(() =>
        expect(mocks.folder.move).toHaveBeenCalledWith({ path: 'Work', parent: 'Personal' })
      )

      // What the main process emits once the directory has moved on disk.
      setData([], [folder('Personal'), folder('Personal/Work canvas')])
      mocks.subscriptions.forEach((cb) => cb())

      await waitFor(() => expect(rowByKey('folder:Personal/Work canvas')).not.toBeNull())
      // The row the prediction named was never rendered — nothing to focus.
      expect(rowByKey('folder:Personal/Work')).toBeNull()
      await waitFor(() =>
        expect(
          rowByKey('folder:Personal/Work canvas')?.querySelector(
            '[data-slot="sidebar-menu-button"]'
          )
        ).toHaveFocus()
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
