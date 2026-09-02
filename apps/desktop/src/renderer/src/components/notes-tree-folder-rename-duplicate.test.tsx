/**
 * Verification: does a folder survive being renamed twice, then deleted?
 *
 * The sidebar tree is the union of two independent sources: the filesystem
 * folder list (`getFolders`) and the folder paths `buildTreeFromNotes`
 * synthesizes from every note's `path` in the index. `handleFolderRenameSubmit`
 * renames on disk and then refreshes only the folders query, so the notes list
 * keeps serving `Old/…` paths and the tree draws the folder twice — the real,
 * now-empty one from disk and a phantom carrying every note.
 *
 * The phantom is a live row wired to the same destructive handlers, so the next
 * thing the user does to it (delete, rename) is aimed at a path that no longer
 * exists.
 *
 * These tests drive a stateful fake vault: `vault*` is what is on disk,
 * `published*` is what each query last handed the renderer. Only `refetch`
 * moves disk state into published state, which is exactly the asymmetry that
 * produces the bug.
 */

import type React from 'react'
import { useEffect, useReducer } from 'react'
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { NotesTree } from './notes-tree'
import type { NoteListItem } from '@/hooks/use-notes-query'
import type { FolderInfo } from '../../../preload/index.d'
import { TooltipProvider } from '@/components/ui/tooltip'

// ============================================================================
// Fake vault
// ============================================================================

interface VaultState {
  folders: FolderInfo[]
  notes: NoteListItem[]
}

const vault: VaultState = { folders: [], notes: [] }
let publishedFolders: FolderInfo[] = []
let publishedNotes: NoteListItem[] = []

const subscribers = new Set<() => void>()
const emit = (): void => {
  subscribers.forEach((fn) => fn())
}

/** Re-render every consumer when the fake queries republish. */
function useVaultSubscription(): void {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    subscribers.add(force)
    return () => {
      subscribers.delete(force)
    }
  }, [])
}

const isUnder = (candidate: string, folderPath: string): boolean =>
  candidate === folderPath || candidate.startsWith(`${folderPath}/`)

const mocks = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn()
}))

/** `fs.rename`: moves the directory and everything under it, ENOENT if absent. */
const renameFolderOnDisk = async (oldPath: string, newPath: string): Promise<unknown> => {
  if (!vault.folders.some((f) => f.path === oldPath)) {
    throw new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`)
  }
  vault.folders = vault.folders.map((f) =>
    isUnder(f.path, oldPath) ? { ...f, path: newPath + f.path.slice(oldPath.length) } : f
  )
  vault.notes = vault.notes.map((n) =>
    isUnder(n.path, oldPath) ? { ...n, path: newPath + n.path.slice(oldPath.length) } : n
  )
  return { success: true }
}

/** `rm -rf` with `force: true`: silent no-op when the path is already gone. */
const deleteFolderOnDisk = async (folderPath: string): Promise<unknown> => {
  vault.folders = vault.folders.filter((f) => !isUnder(f.path, folderPath))
  vault.notes = vault.notes.filter((n) => !isUnder(n.path, folderPath))
  return { success: true }
}

// ============================================================================
// Module mocks
// ============================================================================

vi.mock('@/lib/ipc-error', () => ({
  extractErrorMessage: (_err: unknown, fallback: string) => fallback
}))

vi.mock('@/lib/telemetry-diagnostics', () => ({
  trackRendererError: vi.fn()
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab: vi.fn(), closeTab: vi.fn() }),
  useTabActions: () => ({
    openTab: vi.fn(),
    closeTab: vi.fn(),
    updateTabTitleByEntityId: vi.fn()
  })
}))

vi.mock('@/hooks/use-notes-query', () => ({
  useNotesList: vi.fn(),
  useNoteFoldersQuery: vi.fn(),
  useNoteMutations: vi.fn(),
  notesKeys: {
    notes: () => ['notes'],
    note: (id: string) => ['notes', id],
    lists: () => ['notes', 'list'],
    folders: () => ['notes', 'folders']
  }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    getFolderConfig: vi.fn().mockResolvedValue({}),
    setFolderConfig: vi.fn().mockResolvedValue({}),
    getFolderTemplate: vi.fn().mockResolvedValue(null),
    openExternal: vi.fn().mockResolvedValue({}),
    revealInFinder: vi.fn().mockResolvedValue({}),
    deleteFolder: mocks.deleteFolder,
    renameFolder: mocks.renameFolder,
    getAllPositions: vi.fn().mockResolvedValue({ success: true, positions: {} }),
    reorder: vi.fn().mockResolvedValue({ success: true })
  }
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({
    settings: {
      createInSelectedFolder: true,
      theme: 'system' as const,
      fontSize: 'medium' as const,
      fontFamily: 'system' as const,
      accentColor: '#6366f1',
      startOnBoot: false,
      language: 'en',
      onboardingCompleted: false
    },
    isLoading: false,
    error: null,
    updateSettings: vi.fn().mockResolvedValue(true)
  })
}))

vi.mock('@/components/note/template-selector', () => ({
  TemplateSelector: () => <div data-testid="template-selector">Template Selector</div>
}))

// The real dialog is a Radix portal with its own open animation. Flatten it to
// a single confirm button so the delete path can be driven directly.
vi.mock('@/components/note-tree-dialogs', () => ({
  NoteTreeDeleteDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? (
      <button type="button" data-testid="confirm-delete" onClick={onConfirm}>
        Confirm delete
      </button>
    ) : null,
  NoteTreeTemplateSelector: () => null
}))

// Radix renders menu content only once opened through a real pointer stack.
// Flattening it keeps every row's menu in the DOM, so a row can be located and
// its own items clicked directly. Both trees import this same module.
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="row">{children}</div>
  ),
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />
}))

// jsdom measures every element at 0px, so the real virtualizer would render no
// rows at all. Mount a viewport's worth instead of every row: the real
// virtualizer never mounts more than the visible rows plus its overscan, and
// every keystroke into the rename input re-renders the whole tree, so mounting
// all 150 fillers made each two-rename test cost ~4,800 row renders and 15s on
// a quiet CI worker (#1921). The folder under test is row 0.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 20) }, (_, index) => ({
        index,
        key: index,
        start: index * 28,
        size: 28
      })),
    getTotalSize: () => count * 28,
    scrollToIndex: mocks.scrollToIndex
  })
}))

import { useNotesList, useNoteFoldersQuery, useNoteMutations } from '@/hooks/use-notes-query'

// ============================================================================
// Harness
// ============================================================================

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

const createNote = (id: string, path: string): NoteListItem => ({
  id,
  path,
  title: path.split('/').pop()?.replace('.md', '') || 'Untitled',
  emoji: null,
  created: new Date(),
  modified: new Date(),
  wordCount: 100,
  tags: []
})

const seedVault = (state: VaultState): void => {
  vault.folders = state.folders
  vault.notes = state.notes
  publishedFolders = [...vault.folders]
  publishedNotes = [...vault.notes]
}

const wireHooks = (): void => {
  mocks.renameFolder.mockImplementation(renameFolderOnDisk)
  mocks.deleteFolder.mockImplementation(deleteFolderOnDisk)
  // A real TanStack query keyed exactly like `notesKeys.lists()`. In production
  // the notes list is refetched whenever something invalidates that key, and
  // that refetch is the only thing that can clear a stale folder path out of
  // the tree — so the harness has to honour invalidation, not just `refetch()`.
  ;(useNotesList as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const query = useQuery({
      queryKey: ['notes', 'list'],
      queryFn: async () => {
        publishedNotes = [...vault.notes]
        return publishedNotes
      }
    })
    return {
      notes: query.data ?? [],
      isLoading: query.isLoading,
      isFetching: query.isFetching,
      error: query.error,
      refetch: () => void query.refetch(),
      total: query.data?.length ?? 0,
      hasMore: false
    }
  })
  ;(useNoteFoldersQuery as ReturnType<typeof vi.fn>).mockImplementation(() => {
    useVaultSubscription()
    return {
      folders: publishedFolders,
      isLoading: false,
      error: null,
      refetch: vi.fn().mockImplementation(async () => {
        publishedFolders = [...vault.folders]
        emit()
      }),
      createFolder: vi.fn().mockResolvedValue(true),
      setFolderIcon: vi.fn().mockResolvedValue(true)
    }
  })
  ;(useNoteMutations as ReturnType<typeof vi.fn>).mockReturnValue({
    createNote: {
      mutateAsync: vi
        .fn()
        .mockResolvedValue({ success: true, note: { id: 'new-note', path: 'Untitled.md' } })
    },
    deleteNote: { mutateAsync: vi.fn().mockResolvedValue({ success: true }) },
    renameNote: { mutateAsync: vi.fn().mockResolvedValue({ success: true, note: {} }) },
    moveNote: { mutateAsync: vi.fn().mockResolvedValue({ success: true, note: {} }) }
  })
}

const renderTree = () =>
  render(
    <I18nextProvider i18n={i18nEn}>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
          })
        }
      >
        <TooltipProvider>
          <NotesTree />
        </TooltipProvider>
      </QueryClientProvider>
    </I18nextProvider>
  )

const folderRows = (name: string): HTMLElement[] =>
  screen
    .queryAllByText(name)
    .map((el) => el.closest('[data-testid="row"]'))
    .filter((el): el is HTMLElement => el !== null)

/** Open the inline rename input on `name`'s row and commit `nextName`. */
const renameFolderTo = async (name: string, nextName: string): Promise<void> => {
  const user = userEvent.setup()
  const rows = folderRows(name)
  expect(rows).toHaveLength(1)

  await user.click(within(rows[0]).getByRole('button', { name: /^rename$/i }))

  const input = screen.getByRole('textbox', { name: /rename/i })
  // The input focuses itself a frame after mounting; typing before that lands
  // its `select()` mid-word.
  await waitFor(() => expect(input).toHaveFocus())

  await user.clear(input)
  await user.type(input, `${nextName}{Enter}`)

  await waitFor(() => expect(screen.queryByRole('textbox', { name: /rename/i })).toBeNull())
}

const deleteFolderNamed = async (name: string): Promise<void> => {
  const user = userEvent.setup()
  const rows = folderRows(name)
  expect(rows).toHaveLength(1)

  await user.click(within(rows[0]).getByRole('button', { name: /^delete$/i }))
  await user.click(await screen.findByTestId('confirm-delete'))
  await waitFor(() => expect(screen.queryByTestId('confirm-delete')).toBeNull())
}

const notesInVault = (): string[] => vault.notes.map((n) => n.path).sort()

/** Every folder path the tree currently has a node for. */
const folderNodePaths = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-tree-node-id]')]
    .map((el) => el.getAttribute('data-tree-node-id') ?? '')
    .filter((id) => id.startsWith('folder-'))
    .map((id) => id.slice('folder-'.length))

/** The notes list resolves a microtask after mount; wait for the first paint. */
const renderSettled = async () => {
  const utils = renderTree()
  await waitFor(() => expect(folderRows('Projcts')).toHaveLength(1))
  return utils
}

// 150 root notes push the tree past VIRTUALIZATION_THRESHOLD (100 items), so
// the sidebar swaps in `VirtualizedNotesTree` — the renderer the reporter was
// on, and the one #1529 taught to render a rename input at all.
const filler = Array.from({ length: 150 }, (_, i) => createNote(`filler-${i}`, `Note ${i}.md`))

describe('folder rename → rename → delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    subscribers.clear()
  })

  describe.each([
    ['below the virtualization threshold', [] as NoteListItem[]],
    ['above the virtualization threshold', filler]
  ])('%s', (_label, extraNotes) => {
    beforeEach(() => {
      seedVault({
        folders: [{ path: 'Projcts', icon: null }],
        notes: [
          createNote('n1', 'Projcts/Alpha.md'),
          createNote('n2', 'Projcts/Beta.md'),
          ...extraNotes
        ]
      })
      wireHooks()
    })

    it('renaming a folder that holds notes leaves exactly one folder row', async () => {
      await renderSettled()

      await renameFolderTo('Projcts', 'Projects')

      await waitFor(() => expect(folderRows('Projects')).toHaveLength(1))
      expect(folderRows('Projcts')).toHaveLength(0)
    })

    it('the old folder path leaves the tree entirely', async () => {
      const { container } = await renderSettled()

      await renameFolderTo('Projcts', 'Projects')

      await waitFor(() => expect(folderNodePaths(container)).toContain('Projects'))
      expect(folderNodePaths(container)).not.toContain('Projcts')

      // `publishedNotes` is what the notes query last handed the tree. The old
      // folder can only leave the tree if that query was refetched, so this is
      // the fix itself: refreshing the folder list alone is not enough.
      expect(publishedNotes.map((n) => n.path)).toContain('Projects/Alpha.md')
      expect(publishedNotes.some((n) => n.path.startsWith('Projcts/'))).toBe(false)
    })

    it('a second rename targets the new path, not the one already gone', async () => {
      await renderSettled()

      await renameFolderTo('Projcts', 'Projects')
      await waitFor(() => expect(folderRows('Projects')).toHaveLength(1))

      await renameFolderTo('Projects', 'Project Notes')

      expect(mocks.renameFolder).toHaveBeenLastCalledWith('Projects', 'Project Notes')
      await waitFor(() => expect(folderRows('Project Notes')).toHaveLength(1))
      expect(vault.folders.map((f) => f.path)).toEqual(['Project Notes'])
    })

    it('deleting after a rename removes the folder and nothing else', async () => {
      await renderSettled()

      await renameFolderTo('Projcts', 'Projects')
      await waitFor(() => expect(folderRows('Projects')).toHaveLength(1))

      await deleteFolderNamed('Projects')

      expect(mocks.deleteFolder).toHaveBeenCalledWith('Projects')
      expect(vault.folders).toEqual([])
      expect(notesInVault()).toEqual(extraNotes.map((n) => n.path).sort())
    })

    // The reported sequence, end to end: a folder named with a typo, corrected
    // by a second rename, then the leftover deleted.
    it('rename, rename again, delete — nothing is left behind', async () => {
      const { container } = await renderSettled()

      await renameFolderTo('Projcts', 'Projects')
      await waitFor(() => expect(folderNodePaths(container)).toEqual(['Projects']))

      await renameFolderTo('Projects', 'Project Notes')
      await waitFor(() => expect(folderNodePaths(container)).toEqual(['Project Notes']))

      await deleteFolderNamed('Project Notes')
      await waitFor(() => expect(folderNodePaths(container)).toEqual([]))

      expect(notesInVault()).toEqual(extraNotes.map((n) => n.path).sort())
    })

    // Expansion is keyed by folder path. Renaming must move that key, not drop
    // it: a rename changes the name and nothing else.
    it('an open folder stays open through a rename', async () => {
      await renderSettled()
      const user = userEvent.setup()

      // Open it, and confirm the notes inside are on screen. Clicking the label
      // bubbles to the row's expand handler in both renderers.
      await user.click(screen.getAllByText('Projcts')[0])
      expect(await screen.findByText('Alpha')).toBeInTheDocument()

      await renameFolderTo('Projcts', 'Projects')

      await waitFor(() => expect(folderRows('Projects')).toHaveLength(1))
      expect(screen.getByText('Alpha')).toBeInTheDocument()
      expect(screen.getByText('Beta')).toBeInTheDocument()
    })

    it('a renamed folder is still renameable and does not revert', async () => {
      await renderSettled()

      await renameFolderTo('Projcts', 'Projects')
      await waitFor(() => expect(folderRows('Projects')).toHaveLength(1))
      await renameFolderTo('Projects', 'Project Notes')

      await waitFor(() => expect(folderRows('Project Notes')).toHaveLength(1))
      expect(folderRows('Projects')).toHaveLength(0)
      expect(folderRows('Projcts')).toHaveLength(0)
    })
  })
})
