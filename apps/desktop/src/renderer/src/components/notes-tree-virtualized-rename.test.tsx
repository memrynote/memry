/**
 * Verification: does the sidebar's rename input survive virtualization?
 *
 * The sidebar swaps whole components at `VIRTUALIZATION_THRESHOLD` (100 tree
 * items). `notes-tree.test.tsx` pins `shouldVirtualize` to false and stubs
 * `VirtualizedNotesTree` out entirely, so nothing in the suite exercises the
 * component real users above that threshold actually get.
 */

import type React from 'react'
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { NotesTree } from './notes-tree'
import type { NoteListItem } from '@/hooks/use-notes-query'
import type { FolderInfo } from '../../../preload/index.d'
import { TooltipProvider } from '@/components/ui/tooltip'

const mocks = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  renameFolder: vi.fn().mockResolvedValue({})
}))

vi.mock('@/lib/ipc-error', () => ({
  extractErrorMessage: (_err: unknown, fallback: string) => fallback
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
  notesKeys: { notes: () => ['notes'], note: (id: string) => ['notes', id] }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    getFolderConfig: vi.fn().mockResolvedValue({}),
    setFolderConfig: vi.fn().mockResolvedValue({}),
    getFolderTemplate: vi.fn().mockResolvedValue(null),
    openExternal: vi.fn().mockResolvedValue({}),
    revealInFinder: vi.fn().mockResolvedValue({}),
    deleteFolder: vi.fn().mockResolvedValue({}),
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

// Radix renders menu content only once opened through a real pointer stack.
// Flattening it keeps every row's menu in the DOM, so a row can be located and
// its own Rename item clicked directly. Both trees import this same module.
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
// rows at all and "no input" would prove nothing. Force every row to mount.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
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

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

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

const folders: FolderInfo[] = [{ path: 'Projects', icon: null }]

const setupMocks = (notes: NoteListItem[]) => {
  ;(useNotesList as ReturnType<typeof vi.fn>).mockReturnValue({
    notes,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
    total: notes.length,
    hasMore: false
  })
  ;(useNoteFoldersQuery as ReturnType<typeof vi.fn>).mockReturnValue({
    folders,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    refreshFolders: vi.fn(),
    createFolder: vi.fn().mockResolvedValue(true),
    setFolderIcon: vi.fn().mockResolvedValue(true)
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

const clickRenameOnProjectsFolder = async () => {
  const user = userEvent.setup()
  const row = screen.getAllByText('Projects')[0].closest('[data-testid="row"]')
  expect(row).not.toBeNull()
  await user.click(within(row as HTMLElement).getByRole('button', { name: /rename/i }))
}

const smallVault = [
  createNote('n1', 'Projects/Alpha.md'),
  createNote('n2', 'Projects/Beta.md'),
  createNote('n3', 'Root.md')
]

const largeVault = [
  ...Array.from({ length: 150 }, (_, i) => createNote(`n${i}`, `Note ${i}.md`)),
  createNote('p1', 'Projects/Alpha.md')
]

describe('sidebar folder rename across the virtualization threshold', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('below the threshold: Rename opens an inline input', async () => {
    setupMocks(smallVault)
    renderTree()

    expect(screen.queryByRole('textbox', { name: /rename/i })).not.toBeInTheDocument()
    await clickRenameOnProjectsFolder()

    expect(screen.getByRole('textbox', { name: /rename/i })).toBeInTheDocument()
  })

  it('above the threshold: Rename opens an inline input too', async () => {
    setupMocks(largeVault)
    renderTree()

    await clickRenameOnProjectsFolder()

    expect(screen.getByRole('textbox', { name: /rename/i })).toBeInTheDocument()
  })

  it('above the threshold: renaming a note opens an inline input too', async () => {
    setupMocks(largeVault)
    renderTree()

    const user = userEvent.setup()
    const row = screen.getAllByText('Note 0')[0].closest('[data-testid="row"]')
    expect(row).not.toBeNull()
    await user.click(within(row as HTMLElement).getByRole('button', { name: /rename/i }))

    expect(screen.getByRole('textbox', { name: /rename/i })).toBeInTheDocument()
  })

  // The mock above mounts every row; the real virtualizer mounts only visible
  // ones. A folder created from the sidebar goes straight into rename mode and
  // usually sorts off screen, so unless the tree scrolls to it there is still
  // no input to type into.
  it('above the threshold: entering rename mode scrolls the row into view', async () => {
    setupMocks(largeVault)
    const { container } = renderTree()

    // Rows are mounted in flattened order, so their DOM order is the order the
    // virtualizer indexes into.
    const flattenedIds = [...container.querySelectorAll('[data-tree-node-id]')].map((el) =>
      el.getAttribute('data-tree-node-id')
    )
    const expectedIndex = flattenedIds.indexOf('folder-Projects')
    expect(expectedIndex).toBeGreaterThanOrEqual(0)

    await clickRenameOnProjectsFolder()

    await waitFor(() =>
      expect(mocks.scrollToIndex).toHaveBeenCalledWith(expectedIndex, { align: 'center' })
    )
  })

  it('above the threshold: the inline input commits the rename', async () => {
    setupMocks(largeVault)
    renderTree()

    await clickRenameOnProjectsFolder()

    const input = screen.getByRole('textbox', { name: /rename/i })
    // The input focuses itself a frame after mounting; typing before that lands
    // its `select()` mid-word.
    await waitFor(() => expect(input).toHaveFocus())

    const user = userEvent.setup()
    await user.clear(input)
    await user.type(input, 'Renamed{Enter}')

    await waitFor(() => expect(mocks.renameFolder).toHaveBeenCalledWith('Projects', 'Renamed'))
  })
})
