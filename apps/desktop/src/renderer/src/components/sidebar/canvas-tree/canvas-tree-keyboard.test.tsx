/**
 * Keyboard-only operation of the sidebar canvas tree.
 *
 * Every test here drives the KEYBOARD. macOS keyboards have no context-menu
 * key, so a suite that clicks proves nothing about whether a canvas can be
 * organized without a mouse — which is the §9.2 requirement and a WCAG AA
 * commitment, since HTML5 drag and drop offers no keyboard path at all.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasTree } from './canvas-tree'
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
  subscriptions: [] as Array<() => void>,
  unsubscribe: vi.fn(),
  toastError: vi.fn()
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
  onCanvasFolderUpdated: (cb: () => void) => {
    mocks.subscriptions.push(cb)
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

// Rendered through whichever menu-item component the surrounding menu passes,
// so the bookmark row shows up in BOTH menus and the parity test can see it.
vi.mock('@/components/sidebar/bookmark-menu-item', () => ({
  BookmarkMenuItem: ({
    component: Component
  }: {
    itemType: string
    itemId: string
    component?: React.ComponentType<{ children?: React.ReactNode }>
  }) => (Component ? <Component>bookmark</Component> : <div>bookmark</div>)
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

/** The row's label button — where a Tab-walking user lands on the row itself. */
function rowButton(label: string): HTMLElement {
  const element = screen.getByText(label).closest('button')
  if (!element) throw new Error(`No row button for ${label}`)
  return element
}

/**
 * Walks Tab until `target` has focus. Counting tabs would encode the row's
 * internal control count; what matters is only that Tab REACHES it.
 */
async function tabTo(user: ReturnType<typeof userEvent.setup>, target: HTMLElement): Promise<void> {
  for (let step = 0; step < 20 && document.activeElement !== target; step += 1) {
    await user.tab()
  }
}

describe('CanvasTree keyboard access', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.subscriptions.length = 0
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

  describe('row actions button', () => {
    it('is reachable with Tab and opens its menu with Enter', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' })])
      renderTree()
      await rowsRendered()

      const user = userEvent.setup()
      const trigger = screen.getByLabelText('canvasMenu')
      await tabTo(user, trigger)
      expect(trigger).toHaveFocus()

      await user.keyboard('{Enter}')

      const menu = await screen.findByTestId('canvas-row-actions-menu')
      expect(within(menu).getByText('rename')).toBeInTheDocument()
      expect(within(menu).getByText('moveToFolder')).toBeInTheDocument()
    })

    it('reaches Move to folder and files the canvas without a mouse', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' })], [folder('Work')])
      renderTree()
      await rowsRendered()

      const user = userEvent.setup()
      const trigger = screen.getByLabelText('canvasMenu')
      await tabTo(user, trigger)
      await user.keyboard('{Enter}')

      const menu = await screen.findByTestId('canvas-row-actions-menu')
      fireEvent.keyDown(within(menu).getByText('moveToFolder'), { key: 'Enter' })

      const submenu = await screen.findByTestId('canvas-move-menu')
      fireEvent.keyDown(within(submenu).getByText('Work'), { key: 'Enter' })

      await waitFor(() => {
        expect(mocks.canvas.update).toHaveBeenCalledWith({ id: 'c1', folder: 'Work' })
      })
    })

    it('reaches Move to folder on a FOLDER row and files it without a mouse', async () => {
      // Drag and drop is the only other way to move a folder, and it has no
      // keyboard path at all — so this menu is the whole WCAG AA story.
      setData([], [folder('Work'), folder('Personal')])
      mocks.folder.move.mockResolvedValue({ folder: null })
      renderTree()
      await rowsRendered()

      const user = userEvent.setup()
      const trigger = within(
        screen.getByText('Work').closest('[data-testid="canvas-tree-row"]') as HTMLElement
      ).getByLabelText('folderMenu')
      await tabTo(user, trigger)
      await user.keyboard('{Enter}')

      const menu = await screen.findByTestId('canvas-row-actions-menu')
      fireEvent.keyDown(within(menu).getByText('moveToFolder'), { key: 'Enter' })

      const submenu = await screen.findByTestId('canvas-folder-move-menu')
      fireEvent.keyDown(within(submenu).getByText('Personal'), { key: 'Enter' })

      await waitFor(() =>
        expect(mocks.folder.move).toHaveBeenCalledWith({ path: 'Work', parent: 'Personal' })
      )
    })

    it('gives the folder row a keyboard menu too', async () => {
      setData([], [folder('Work')])
      renderTree()
      await rowsRendered()

      const user = userEvent.setup()
      const trigger = screen.getByLabelText('folderMenu')
      await tabTo(user, trigger)
      expect(trigger).toHaveFocus()

      await user.keyboard('{Enter}')
      const menu = await screen.findByTestId('canvas-row-actions-menu')
      expect(within(menu).getByText('newCanvasHere')).toBeInTheDocument()
      expect(within(menu).getByText('rename')).toBeInTheDocument()
    })

    it('offers exactly the same items as the context menu', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' })], [folder('Work')])

      const first = renderTree()
      await rowsRendered()
      fireEvent.contextMenu(
        screen.getByText('Alpha').closest('[data-testid="canvas-tree-row"]') as HTMLElement
      )
      const contextLabels = within(screen.getByTestId('canvas-tree-menu'))
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
      first.unmount()

      renderTree()
      await rowsRendered()
      const user = userEvent.setup()
      const trigger = screen.getByLabelText('canvasMenu')
      await tabTo(user, trigger)
      await user.keyboard('{Enter}')
      const dropdownLabels = within(await screen.findByTestId('canvas-row-actions-menu'))
        .getAllByRole('menuitem')
        .map((item) => item.textContent)

      expect(dropdownLabels).toEqual(contextLabels)
      expect(dropdownLabels.length).toBeGreaterThan(5)
    })
  })

  describe('row shortcuts', () => {
    it('renames the focused canvas with F2', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' })])
      renderTree()
      await rowsRendered()

      const button = rowButton('Alpha')
      button.focus()
      fireEvent.keyDown(button, { key: 'F2' })

      const dialog = await screen.findByRole('dialog')
      const input = within(dialog).getByRole('textbox')
      fireEvent.change(input, { target: { value: 'Renamed' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(mocks.canvas.update).toHaveBeenCalledWith({ id: 'c1', title: 'Renamed' })
      })
    })

    it('renames the focused folder with F2', async () => {
      setData([], [folder('Work')])
      renderTree()
      await rowsRendered()

      const button = rowButton('Work')
      button.focus()
      fireEvent.keyDown(button, { key: 'F2' })

      const dialog = await screen.findByRole('dialog')
      const input = within(dialog).getByRole('textbox')
      fireEvent.change(input, { target: { value: 'Studio' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(mocks.folder.rename).toHaveBeenCalledWith({ path: 'Work', name: 'Studio' })
      })
    })

    it('deletes the focused canvas with Delete, still behind the confirmation', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' })])
      renderTree()
      await rowsRendered()

      const user = userEvent.setup()
      const button = rowButton('Alpha')
      button.focus()
      fireEvent.keyDown(button, { key: 'Delete' })

      const dialog = await screen.findByRole('alertdialog')
      expect(mocks.canvas.delete).not.toHaveBeenCalled()

      const confirm = within(dialog).getByRole('button', { name: 'delete' })
      confirm.focus()
      await user.keyboard('{Enter}')

      await waitFor(() => expect(mocks.canvas.delete).toHaveBeenCalledWith('c1'))
    })

    it('accepts Backspace as the delete key too', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' })])
      renderTree()
      await rowsRendered()

      const button = rowButton('Alpha')
      button.focus()
      fireEvent.keyDown(button, { key: 'Backspace' })

      expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    })

    it('deletes the focused folder with Delete', async () => {
      setData([], [folder('Work')])
      renderTree()
      await rowsRendered()

      const user = userEvent.setup()
      const button = rowButton('Work')
      button.focus()
      fireEvent.keyDown(button, { key: 'Delete' })

      const dialog = await screen.findByRole('alertdialog')
      const confirm = within(dialog).getByRole('button', { name: 'delete' })
      confirm.focus()
      await user.keyboard('{Enter}')

      await waitFor(() => expect(mocks.folder.delete).toHaveBeenCalledWith({ path: 'Work' }))
    })

    /**
     * The confirmation is the LAST step of the only mouse-free delete path, so
     * focus escaping it ends that path one keystroke from the end.
     *
     * Radix's AlertDialogContent preventDefaults its own auto-focus and focuses
     * `cancelRef` instead — and only `AlertDialogCancel` ever populates that ref.
     * A footer built from plain buttons therefore opens with `activeElement` on
     * `document.body`: nothing to Tab from, nothing to Enter, and Esc handled by
     * a layer the user cannot see they are in.
     *
     * Nothing here calls `.focus()`. That is the point — the other delete tests
     * do, which is exactly why they stayed green while this was broken.
     */
    it('opens the delete confirmation with focus inside it, and confirms by keyboard', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' })])
      renderTree()
      await rowsRendered()

      const user = userEvent.setup()
      const button = rowButton('Alpha')
      button.focus()
      fireEvent.keyDown(button, { key: 'Delete' })

      const dialog = await screen.findByRole('alertdialog')
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
      // Cancel first: a destructive dialog must not open on its destructive
      // button, or a held Enter deletes the canvas.
      expect(within(dialog).getByRole('button', { name: 'cancel' })).toHaveFocus()

      await user.tab()
      expect(within(dialog).getByRole('button', { name: 'delete' })).toHaveFocus()
      await user.keyboard('{Enter}')

      await waitFor(() => expect(mocks.canvas.delete).toHaveBeenCalledWith('c1'))
    })

    /**
     * The row's dropdown content is a React CHILD of the row, and React
     * synthetic events propagate through the React tree even across a portal —
     * so a keystroke aimed at the open menu also reached the row's own
     * handler. A user arrowing through the menu could fire the delete they
     * never chose.
     */
    describe('while a row menu is open', () => {
      async function openRowActions(label: string): Promise<void> {
        const user = userEvent.setup()
        const trigger = screen.getByLabelText(label)
        await tabTo(user, trigger)
        await user.keyboard('{Enter}')
        await screen.findByTestId('canvas-row-actions-menu')
      }

      it('does not delete the canvas when Delete is pressed inside the menu', async () => {
        setData([canvas({ id: 'c1', title: 'Alpha' })])
        renderTree()
        await rowsRendered()

        await openRowActions('canvasMenu')
        await userEvent.setup().keyboard('{Delete}')

        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
        expect(mocks.canvas.delete).not.toHaveBeenCalled()
      })

      it('does not rename the canvas when F2 is pressed inside the menu', async () => {
        setData([canvas({ id: 'c1', title: 'Alpha' })])
        renderTree()
        await rowsRendered()

        await openRowActions('canvasMenu')
        await userEvent.setup().keyboard('{F2}')

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      })

      it('does not delete the folder when Delete is pressed inside its menu', async () => {
        setData([], [folder('Work')])
        renderTree()
        await rowsRendered()

        await openRowActions('folderMenu')
        await userEvent.setup().keyboard('{Delete}')

        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
        expect(mocks.folder.delete).not.toHaveBeenCalled()
      })

      it('does not rename the folder when F2 is pressed inside its menu', async () => {
        setData([], [folder('Work')])
        renderTree()
        await rowsRendered()

        await openRowActions('folderMenu')
        await userEvent.setup().keyboard('{F2}')

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      })

      /**
       * A submenu is a second portal one level deeper, and it is still a React
       * child of the row. If the guard only covered the top-level content, a
       * user arrowing through "Move to folder" would still be one keystroke away
       * from destroying the folder they were trying to file.
       */
      it('stays inert while the Move submenu is the thing on screen', async () => {
        setData([], [folder('Personal'), folder('Work')])
        renderTree()
        await rowsRendered()

        const user = userEvent.setup()
        const trigger = within(
          screen.getByText('Work').closest('[data-testid="canvas-tree-row"]') as HTMLElement
        ).getByLabelText('folderMenu')
        await tabTo(user, trigger)
        await user.keyboard('{Enter}')

        const menu = await screen.findByTestId('canvas-row-actions-menu')
        fireEvent.keyDown(within(menu).getByText('moveToFolder'), { key: 'Enter' })
        await screen.findByTestId('canvas-folder-move-menu')

        await user.keyboard('{Delete}')

        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
        expect(mocks.folder.delete).not.toHaveBeenCalled()
      })
    })

    it('leaves an unreadable canvas out of F2, since there is nothing to rename', async () => {
      setData([canvas({ id: 'c1', title: 'Broken', unreadable: true })])
      renderTree()
      await rowsRendered()

      const button = rowButton('Broken')
      button.focus()
      fireEvent.keyDown(button, { key: 'F2' })

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  describe('focus management', () => {
    it('puts focus on the next row after a delete instead of dropping it to the body', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' }), canvas({ id: 'c2', title: 'Beta' })])
      renderTree()
      await rowsRendered()

      const user = userEvent.setup()
      const button = rowButton('Alpha')
      button.focus()
      fireEvent.keyDown(button, { key: 'Delete' })

      const dialog = await screen.findByRole('alertdialog')
      const confirm = within(dialog).getByRole('button', { name: 'delete' })
      confirm.focus()
      await user.keyboard('{Enter}')

      await waitFor(() => expect(mocks.canvas.delete).toHaveBeenCalled())
      await waitFor(() => expect(rowButton('Beta')).toHaveFocus())
    })

    it('returns focus to the row it renamed', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' })])
      renderTree()
      await rowsRendered()

      const button = rowButton('Alpha')
      button.focus()
      fireEvent.keyDown(button, { key: 'F2' })

      const dialog = await screen.findByRole('dialog')
      const input = within(dialog).getByRole('textbox')
      fireEvent.change(input, { target: { value: 'Renamed' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => expect(mocks.canvas.update).toHaveBeenCalled())
      await waitFor(() => expect(rowButton('Alpha')).toHaveFocus())
    })

    /**
     * A folder's row key IS its path, so the row the focus restorer is waiting
     * for does not exist until the refresh that the mutation's IPC event
     * triggers has landed. Anything that gave up on the first tick dropped
     * focus to `document.body` and ended keyboard navigation of the tree.
     */
    it('returns focus to the folder row it renamed, under its NEW name', async () => {
      setData([], [folder('Work')])
      renderTree()
      await rowsRendered()

      const button = rowButton('Work')
      button.focus()
      fireEvent.keyDown(button, { key: 'F2' })

      const dialog = await screen.findByRole('dialog')
      const input = within(dialog).getByRole('textbox')
      fireEvent.change(input, { target: { value: 'Studio' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => expect(mocks.folder.rename).toHaveBeenCalled())

      // What the main process emits once the rename lands on disk.
      setData([], [folder('Studio')])
      mocks.subscriptions.forEach((cb) => cb())

      await waitFor(() => expect(rowButton('Studio')).toHaveFocus())
    })

    it('puts focus on the folder it just created', async () => {
      setData([], [folder('Work')])
      renderTree()
      await rowsRendered()

      const button = rowButton('Work')
      button.focus()
      const user = userEvent.setup()
      const trigger = within(
        screen.getByText('Work').closest('[data-testid="canvas-tree-row"]') as HTMLElement
      ).getByLabelText('folderMenu')
      await tabTo(user, trigger)
      await user.keyboard('{Enter}')
      const menu = await screen.findByTestId('canvas-row-actions-menu')
      fireEvent.click(within(menu).getByText('newFolder'))

      const dialog = await screen.findByRole('dialog')
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Q3' } })
      fireEvent.keyDown(within(dialog).getByRole('textbox'), { key: 'Enter' })

      await waitFor(() => expect(mocks.folder.create).toHaveBeenCalled())

      localStorage.setItem('sidebar-canvas-tree-expanded', JSON.stringify(['Work']))
      setData([], [folder('Work'), folder('Work/Q3')])
      mocks.subscriptions.forEach((cb) => cb())

      await waitFor(() => expect(rowButton('Q3')).toHaveFocus())
    })

    it('skips the rows a folder delete takes with it when choosing where focus lands', async () => {
      localStorage.setItem('sidebar-canvas-tree-expanded', JSON.stringify(['Work']))
      setData(
        [canvas({ id: 'c1', title: 'Beta', folder: 'Work' }), canvas({ id: 'c2', title: 'Gamma' })],
        [folder('Work')]
      )
      renderTree()
      await rowsRendered()

      const user = userEvent.setup()
      const button = rowButton('Work')
      button.focus()
      fireEvent.keyDown(button, { key: 'Delete' })

      const dialog = await screen.findByRole('alertdialog')
      const confirmButton = within(dialog).getByRole('button', { name: 'delete' })
      confirmButton.focus()
      await user.keyboard('{Enter}')

      await waitFor(() => expect(mocks.folder.delete).toHaveBeenCalled())

      setData([canvas({ id: 'c2', title: 'Gamma' })], [])
      mocks.subscriptions.forEach((cb) => cb())

      // Beta is the row directly below Work, but it dies WITH the folder, so
      // landing focus there drops it to the body a tick later.
      await waitFor(() => expect(rowButton('Gamma')).toHaveFocus())
    })
  })

  describe('the rest of the tree', () => {
    it('expands a folder and opens a canvas with Enter alone', async () => {
      setData([canvas({ id: 'c1', title: 'Beta', folder: 'Work' })], [folder('Work')])
      const onCanvasClick = vi.fn()
      renderTree({ onCanvasClick })
      await rowsRendered()

      const user = userEvent.setup()
      const folderRow = rowButton('Work')
      folderRow.focus()
      await user.keyboard('{Enter}')

      await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument())

      const canvasRow = rowButton('Beta')
      canvasRow.focus()
      await user.keyboard('{Enter}')

      expect(onCanvasClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }))
    })

    it('names the folder expander through i18n rather than a bare icon', async () => {
      localStorage.setItem('sidebar-canvas-tree-expanded', JSON.stringify(['Work']))
      setData([canvas({ id: 'c1', title: 'Beta', folder: 'Work' })], [folder('Work')])
      renderTree()
      await rowsRendered()

      expect(screen.getByLabelText('collapseFolder')).toBeInTheDocument()
    })
  })

  /**
   * A vault with no canvases and no folders has no row to right-click and no row
   * to Tab to. Before the empty state grew its own affordances, that state was a
   * dead end: the very first folder could not be created at all.
   */
  describe('from a vault holding nothing', () => {
    it('reaches New folder with Tab and creates the first folder with Enter alone', async () => {
      setData([], [])
      mocks.folder.create.mockResolvedValue({ folder: folder('Work') })
      renderTree()
      await waitFor(() => expect(screen.getByText('empty')).toBeInTheDocument())

      const user = userEvent.setup()
      const newFolder = screen.getByRole('button', { name: 'newFolder' })
      await tabTo(user, newFolder)
      // Tab REACHING it is half the claim: an affordance behind hover only is
      // still mouse-only however visible it looks.
      expect(newFolder).toHaveFocus()

      await user.keyboard('{Enter}')

      const dialog = await screen.findByRole('dialog')
      await user.type(within(dialog).getByRole('textbox'), 'Work{Enter}')

      await waitFor(() =>
        expect(mocks.folder.create).toHaveBeenCalledWith({ parent: null, name: 'Work' })
      )
    })

    it('lands focus on the folder it just created rather than on the body', async () => {
      setData([], [])
      mocks.folder.create.mockResolvedValue({ folder: folder('Work') })
      renderTree()
      await waitFor(() => expect(screen.getByText('empty')).toBeInTheDocument())

      const user = userEvent.setup()
      await tabTo(user, screen.getByRole('button', { name: 'newFolder' }))
      await user.keyboard('{Enter}')

      const dialog = await screen.findByRole('dialog')
      await user.type(within(dialog).getByRole('textbox'), 'Work{Enter}')
      await waitFor(() => expect(mocks.folder.create).toHaveBeenCalled())

      // What the main process emits once the directory and its row exist. The
      // button that opened the dialog is gone by now — the empty state it lived
      // in has been replaced by the list — so Radix has nothing to restore to.
      setData([], [folder('Work')])
      mocks.subscriptions.forEach((cb) => cb())

      await waitFor(() => expect(rowButton('Work')).toHaveFocus())
      expect(document.activeElement).not.toBe(document.body)
    })

    it('parks focus on the empty state after the last row is deleted', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' })])
      renderTree()
      await rowsRendered()

      const user = userEvent.setup()
      const button = rowButton('Alpha')
      button.focus()
      fireEvent.keyDown(button, { key: 'Delete' })

      const dialog = await screen.findByRole('alertdialog')
      const confirm = within(dialog).getByRole('button', { name: 'delete' })
      confirm.focus()
      await user.keyboard('{Enter}')

      await waitFor(() => expect(mocks.canvas.delete).toHaveBeenCalled())

      setData([], [])
      mocks.subscriptions.forEach((cb) => cb())

      // There is no surviving row, so the empty state's own button is the only
      // place left that is not `document.body`.
      await waitFor(() => expect(screen.getByRole('button', { name: 'newCanvas' })).toHaveFocus())
      expect(document.activeElement).not.toBe(document.body)
    })
  })

  /**
   * The menu is the only keyboard path to moving a folder, so what it OFFERS has
   * to be exactly what the store ACCEPTS. A target the store then refuses is a
   * dead menu item; a target it would accept but the menu hides is a move the
   * keyboard user simply cannot make.
   */
  describe('the folder Move submenu against the store rules', () => {
    /**
     * `Deep` carries two levels of its own, and `T1…T6` is a chain to hang it
     * off. The cap is 8: landing under `T5` puts `Deep/One/Two`'s deepest level
     * at exactly 8, and under `T6` at 9.
     */
    function setDepthData(): void {
      setData(
        [],
        [
          folder('Deep'),
          folder('Deep/One'),
          folder('Deep/One/Two'),
          folder('T1'),
          folder('T1/T2'),
          folder('T1/T2/T3'),
          folder('T1/T2/T3/T4'),
          folder('T1/T2/T3/T4/T5'),
          folder('T1/T2/T3/T4/T5/T6')
        ]
      )
    }

    async function openMoveSubmenu(label: string): Promise<HTMLElement> {
      const user = userEvent.setup()
      const trigger = within(
        screen.getByText(label).closest('[data-testid="canvas-tree-row"]') as HTMLElement
      ).getByLabelText('folderMenu')
      await tabTo(user, trigger)
      await user.keyboard('{Enter}')
      const menu = await screen.findByTestId('canvas-row-actions-menu')
      fireEvent.keyDown(within(menu).getByText('moveToFolder'), { key: 'Enter' })
      return screen.findByTestId('canvas-folder-move-menu')
    }

    it('offers the deepest target the subtree still fits under', async () => {
      setDepthData()
      renderTree()
      await rowsRendered()

      const submenu = await openMoveSubmenu('Deep')
      expect(within(submenu).getByText('T5')).toBeInTheDocument()
    })

    it('leaves out a target that the dragged subtree would push past the cap', async () => {
      setDepthData()
      renderTree()
      await rowsRendered()

      const submenu = await openMoveSubmenu('Deep')
      // `Deep` alone would fit under T6; its grandchild would not, and the whole
      // subtree rides along.
      expect(within(submenu).queryByText('T6')).not.toBeInTheDocument()
    })

    it('leaves out the folder itself and everything beneath it', async () => {
      setDepthData()
      renderTree()
      await rowsRendered()

      const submenu = await openMoveSubmenu('Deep')
      for (const own of ['Deep', 'One', 'Two']) {
        expect(within(submenu).queryByText(own)).not.toBeInTheDocument()
      }
    })
  })

  /**
   * A destructive confirmation may not understate its blast radius. The rendered
   * node carries the FILTERED count, which is right for its badge and a lie here.
   */
  it('states the TRUE canvas count in a folder delete while a filter hides some', async () => {
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

    const user = userEvent.setup()
    await tabTo(user, screen.getByLabelText('filterPlaceholder'))
    await user.keyboard('roadmap')
    await waitFor(() => expect(screen.getByText('Roadmap')).toBeInTheDocument())

    const trigger = within(
      screen.getByText('Work').closest('[data-testid="canvas-tree-row"]') as HTMLElement
    ).getByLabelText('folderMenu')
    await tabTo(user, trigger)
    await user.keyboard('{Enter}')

    const menu = await screen.findByTestId('canvas-row-actions-menu')
    fireEvent.keyDown(within(menu).getByText('delete'), { key: 'Enter' })

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/deleteFolderConfirmBody:3/)).toBeInTheDocument()
  })

  /**
   * Both menus render the SAME `CanvasMenuEntry[]`. Comparing the two label
   * lists proves they agree — but it stays green when an item is dropped from
   * the shared source, because both lose it together. Naming the items is what
   * turns that into a real assertion: a single deletion has to fail on BOTH
   * sides, which is the property "one source" is supposed to buy.
   */
  describe('one source of menu items', () => {
    async function dropdownLabels(rowLabel: string, menuLabel: string): Promise<string[]> {
      const user = userEvent.setup()
      const trigger = within(
        screen.getByText(rowLabel).closest('[data-testid="canvas-tree-row"]') as HTMLElement
      ).getByLabelText(menuLabel)
      await tabTo(user, trigger)
      await user.keyboard('{Enter}')
      return within(await screen.findByTestId('canvas-row-actions-menu'))
        .getAllByRole('menuitem')
        .map((item) => item.textContent ?? '')
    }

    function contextLabels(rowLabel: string): string[] {
      fireEvent.contextMenu(
        screen.getByText(rowLabel).closest('[data-testid="canvas-tree-row"]') as HTMLElement
      )
      return within(screen.getByTestId('canvas-tree-menu'))
        .getAllByRole('menuitem')
        .map((item) => item.textContent ?? '')
    }

    it('gives a canvas row the same named items in both menus', async () => {
      setData([canvas({ id: 'c1', title: 'Alpha' })], [folder('Work')])

      const first = renderTree()
      await rowsRendered()
      const fromContext = contextLabels('Alpha')
      first.unmount()

      renderTree()
      await rowsRendered()
      const fromDropdown = await dropdownLabels('Alpha', 'canvasMenu')

      // Soft so ONE deletion from the shared source is seen failing on BOTH
      // sides in a single run, rather than the first assertion masking the second.
      for (const label of ['rename', 'duplicate', 'moveToFolder', 'openExternal', 'delete']) {
        expect.soft(fromContext).toContain(label)
        expect.soft(fromDropdown).toContain(label)
      }
      expect(fromDropdown).toEqual(fromContext)
    })

    it('gives a folder row the same named items in both menus', async () => {
      setData([], [folder('Work')])

      const first = renderTree()
      await rowsRendered()
      const fromContext = contextLabels('Work')
      first.unmount()

      renderTree()
      await rowsRendered()
      const fromDropdown = await dropdownLabels('Work', 'folderMenu')

      for (const label of ['newCanvasHere', 'newFolder', 'rename', 'moveToFolder', 'delete']) {
        expect.soft(fromContext).toContain(label)
        expect.soft(fromDropdown).toContain(label)
      }
      expect(fromDropdown).toEqual(fromContext)
    })
  })
})
