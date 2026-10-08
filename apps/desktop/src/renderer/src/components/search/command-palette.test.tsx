import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SearchReason,
  SearchResultGroup,
  SearchResultItem,
  SearchResultMetadata
} from '@memry/contracts/search-api'
import { localDayRange } from '@/lib/local-day-range'
import { searchService } from '@/services/search-service'
import { notesService } from '@/services/notes-service'
import { trackTelemetry } from '@/lib/telemetry'
import { CommandPalette } from './command-palette'

const openTab = vi.fn()
let vaultStatus = {
  isIndexing: false,
  indexBuilt: undefined as number | undefined,
  indexTotal: undefined as number | undefined
}

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
    i18n: { resolvedLanguage: 'en', language: 'en' }
  })
}))
vi.mock('@/contexts/tabs', () => ({ useTabs: () => ({ openTab }) }))
vi.mock('@/hooks/use-vault', () => ({ useVault: () => vaultStatus }))
vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn() }))
vi.mock('@/services/search-service', async (importActual) => ({
  ...(await importActual<typeof import('@/services/search-service')>()),
  searchService: {
    query: vi.fn(),
    getReasons: vi.fn(),
    addReason: vi.fn(),
    clearReasons: vi.fn(),
    getStats: vi.fn()
  }
}))
vi.mock('@/services/tags-service', () => ({
  tagsService: {
    getAllWithCounts: vi.fn().mockResolvedValue({
      tags: [
        { name: 'work', count: 12, color: 'blue' },
        { name: 'workout', count: 3, color: 'green' },
        { name: 'home', count: 5, color: 'stone' }
      ]
    })
  }
}))
vi.mock('@/services/notes-service', () => ({ notesService: { get: vi.fn() } }))
vi.mock('@/services/journal-service', () => ({ journalService: { getEntry: vi.fn() } }))
vi.mock('@/services/tasks-service', () => ({ tasksService: { get: vi.fn() } }))
vi.mock('@/services/inbox-service', () => ({ inboxService: { get: vi.fn() } }))

function hit(
  type: SearchResultItem['type'],
  id: string,
  title: string,
  metadata: SearchResultMetadata
) {
  return {
    id,
    type,
    title,
    snippet: '',
    score: 1,
    normalizedScore: 1,
    matchType: 'exact',
    modifiedAt: new Date().toISOString(),
    metadata
  } satisfies SearchResultItem
}

const noteHit = (id: string, title: string, extra: Partial<SearchResultMetadata> = {}) =>
  hit('note', id, title, {
    type: 'note',
    path: `Projects/${title}.md`,
    tags: [],
    ...extra
  } as SearchResultMetadata)

function respondWith(groups: SearchResultGroup[]): void {
  vi.mocked(searchService.query).mockResolvedValue({
    groups,
    totalCount: groups.reduce((n, g) => n + g.results.length, 0),
    queryTimeMs: 4
  })
}

const group = (items: SearchResultItem[]): SearchResultGroup => ({
  type: items[0].type,
  results: items,
  totalInGroup: items.length
})

function renderPalette(): {
  onOpenChange: ReturnType<typeof vi.fn>
  user: ReturnType<typeof userEvent.setup>
} {
  const onOpenChange = vi.fn()
  render(<CommandPalette open onOpenChange={onOpenChange} />)
  return { onOpenChange, user: userEvent.setup() }
}

const input = (): HTMLInputElement => screen.getByRole('combobox')
const selectedRow = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]')
const rowTitles = (): string[] =>
  screen.getAllByRole('option').map((option) => option.textContent ?? '')
const lastQuery = () => vi.mocked(searchService.query).mock.lastCall?.[0]

beforeEach(() => {
  vi.clearAllMocks()
  Element.prototype.scrollIntoView = vi.fn()
  vaultStatus = { isIndexing: false, indexBuilt: undefined, indexTotal: undefined }
  respondWith([])
  vi.mocked(searchService.getReasons).mockResolvedValue([])
  vi.mocked(searchService.addReason).mockResolvedValue({} as SearchReason)
  vi.mocked(searchService.clearReasons).mockResolvedValue({ cleared: true })
  vi.mocked(searchService.getStats).mockResolvedValue({
    totalNotes: 0,
    totalJournals: 0,
    totalTasks: 0,
    totalInboxItems: 0,
    totalIndexed: 42,
    lastIndexedAt: null
  })
  vi.mocked(notesService.get).mockResolvedValue(null)
})

describe('CommandPalette open state', () => {
  const reasons: SearchReason[] = [
    {
      id: 'r1',
      itemId: 'task-1',
      itemType: 'task',
      itemTitle: 'Renew passport',
      itemIcon: null,
      searchQuery: 'passport',
      visitedAt: '2026-03-12T10:00:00.000Z'
    },
    {
      id: 'r2',
      itemId: 'note-1',
      itemType: 'note',
      itemTitle: 'Turkey trip',
      itemIcon: 'custom:1l4E1zFoOCBC_x6h',
      searchQuery: 'turkey',
      visitedAt: '2026-03-12T10:00:00.000Z'
    }
  ]

  it('lists the recent trail with the query that found each item, and opens one by keyboard', async () => {
    vi.mocked(searchService.getReasons).mockResolvedValue(reasons)
    const { user, onOpenChange } = renderPalette()

    expect(await screen.findByText('Renew passport')).toBeInTheDocument()
    expect(screen.getByText(/fromQuery.*passport/)).toBeInTheDocument()
    // #2564: a custom note icon renders as an image, never as its raw reference.
    expect(document.body.textContent).not.toContain('custom:')
    expect(selectedRow()).toHaveTextContent('Renew passport')

    await user.keyboard('{ArrowDown}{Enter}')

    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'note-1' })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('reports how many items are searchable on this device', async () => {
    renderPalette()
    expect(await screen.findByText(/status\.items.*"count":42/)).toBeInTheDocument()
  })
})

describe('CommandPalette opening results', () => {
  const cases: Array<{
    name: string
    item: SearchResultItem
    tab: Record<string, unknown>
  }> = [
    {
      name: 'a note in the editor',
      item: noteHit('note-1', 'Roadmap'),
      tab: { type: 'note', path: '/note/note-1', entityId: 'note-1' }
    },
    {
      // #800: a filed binary must never reach the markdown editor.
      name: 'a filed PDF in the file viewer',
      item: noteHit('file-1', 'Roadmap scan', { fileType: 'pdf' }),
      tab: { type: 'file', path: '/file/file-1' }
    },
    {
      name: 'a journal entry on its day',
      item: hit('journal', 'j1', 'Roadmap thoughts', {
        type: 'journal',
        date: '2026-06-10',
        path: 'journal/2026-06-10.md',
        tags: []
      }),
      tab: { type: 'journal', path: '/journal/2026-06-10' }
    },
    {
      // The tasks page reads `openTaskId`; archived hits used to land on an empty overview.
      name: 'a task in its drawer',
      item: hit('task', 'task-1', 'Roadmap review', {
        type: 'task',
        projectId: 'p1',
        projectName: 'Launch',
        projectColor: '#8b5cf6',
        statusId: null,
        statusName: 'Todo',
        dueDate: null,
        priority: 3,
        completedAt: null
      }),
      tab: {
        type: 'tasks',
        viewState: expect.objectContaining({ openTaskId: 'task-1', projectId: 'p1' })
      }
    },
    {
      name: 'an inbox item highlighted in the inbox',
      item: hit('inbox', 'in-1', 'Roadmap article', {
        type: 'inbox',
        itemType: 'link',
        sourceUrl: 'https://linear.app/now',
        sourceTitle: null,
        filedAt: null
      }),
      tab: { type: 'inbox', viewState: { highlightItemId: 'in-1' } }
    }
  ]

  it.each(cases)('opens $name', async ({ item, tab }) => {
    respondWith([group([item])])
    const { user } = renderPalette()

    await user.type(input(), 'road')
    await waitFor(() => expect(selectedRow()).toHaveTextContent(item.title))
    await user.keyboard('{Enter}')

    expect(openTab).toHaveBeenCalledWith(expect.objectContaining(tab))
    expect(trackTelemetry).toHaveBeenCalledWith('search_result_opened', {
      surface: 'search',
      action: 'opened',
      objectType: item.type
    })
    await waitFor(() =>
      expect(searchService.addReason).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: item.id, searchQuery: 'road' })
      )
    )
  })

  it('collapses a long group and reveals the rest on request', async () => {
    respondWith([group(Array.from({ length: 7 }, (_, i) => noteHit(`n${i}`, `Note ${i}`)))])
    const { user } = renderPalette()

    await user.type(input(), 'note')
    await waitFor(() => expect(rowTitles()).toContain('Note 0Projects'))
    expect(rowTitles()).not.toContain('Note 5Projects')

    await user.click(screen.getByRole('option', { name: /showMore.*"count":2/ }))

    expect(rowTitles()).toContain('Note 6Projects')
  })

  it('previews the selected note with the lines that matched', async () => {
    respondWith([group([noteHit('note-1', 'Roadmap')])])
    vi.mocked(notesService.get).mockResolvedValue({
      content: '# Plan\nThree bets for the quarter.\n\nThe public roadmap ships with 0.9.'
    } as Awaited<ReturnType<typeof notesService.get>>)
    const { user } = renderPalette()

    await user.type(input(), 'roadmap')

    const matches = (await screen.findByText('searchPalette.matches')).closest('section')!
    expect(notesService.get).toHaveBeenCalledWith('note-1')
    expect(within(matches).getByText(/ships with 0\.9/)).toBeInTheDocument()
    expect(within(matches).queryByText(/Three bets/)).not.toBeInTheDocument()
  })

  it('moves between sections with Tab', async () => {
    respondWith([
      group([noteHit('n1', 'Roadmap note')]),
      group([
        hit('inbox', 'in-1', 'Roadmap link', {
          type: 'inbox',
          itemType: 'link',
          sourceUrl: null,
          sourceTitle: null,
          filedAt: null
        })
      ])
    ])
    const { user } = renderPalette()

    await user.type(input(), 'road')
    await waitFor(() => expect(selectedRow()).toHaveTextContent('Roadmap note'))
    await user.keyboard('{Tab}')

    expect(selectedRow()).toHaveTextContent('Roadmap link')
  })
})

describe('CommandPalette filters', () => {
  it('opens the filter menu on "/" and turns a pick into a chip the query honors', async () => {
    const { user } = renderPalette()

    await user.type(input(), '/task')
    await waitFor(() => expect(selectedRow()).toHaveTextContent('searchPalette.types.task'))
    await user.keyboard('{Enter}{Backspace}')
    await user.type(input(), 'design')

    await waitFor(() =>
      expect(lastQuery()).toEqual(expect.objectContaining({ text: 'design', types: ['task'] }))
    )
    expect(screen.getByRole('button', { name: /removeFilter/ })).toBeInTheDocument()
  })

  it('removes the last chip with Backspace on an empty query', async () => {
    const { user } = renderPalette()

    await user.keyboard('{Control>}3{/Control}')
    expect(screen.getByRole('button', { name: /removeFilter/ })).toBeInTheDocument()

    await user.click(input())
    await user.keyboard('{Backspace}')

    expect(screen.queryByRole('button', { name: /removeFilter/ })).not.toBeInTheDocument()
  })

  // The presets used to name the UTC date and cover the UTC day, so in a westerly zone "Today"
  // meant tomorrow and excluded the whole local evening (#1954).
  it('scopes the Today preset to the local day', async () => {
    const { user } = renderPalette()

    await user.type(input(), '/today')
    await waitFor(() => expect(selectedRow()).toHaveTextContent('searchPalette.dates.today'))
    await user.keyboard('{Enter}{Backspace}')
    await user.type(input(), 'x')

    const now = new Date()
    const { startAt, endAt } = localDayRange(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    )
    await waitFor(() =>
      expect(lastQuery()?.dateRange).toEqual({
        from: startAt,
        to: new Date(Date.parse(endAt) - 1).toISOString()
      })
    )
  })

  it('adds a tag from the "#" picker', async () => {
    const { user } = renderPalette()

    await user.type(input(), '#wo')
    const picker = await screen.findByRole('option', { name: /workout/ })
    expect(screen.queryByRole('option', { name: /home/ })).not.toBeInTheDocument()
    expect(selectedRow()).toHaveTextContent('#work12')

    await user.keyboard('{Enter}')
    await user.type(input(), 'plan')

    expect(picker).not.toBeInTheDocument()
    await waitFor(() =>
      expect(lastQuery()).toEqual(expect.objectContaining({ text: 'plan', tags: ['work'] }))
    )
  })

  it('backs out of a menu with Escape before closing the palette', async () => {
    const { user, onOpenChange } = renderPalette()

    await user.type(input(), '/')
    await screen.findByText('searchPalette.filterType')
    await user.keyboard('{Escape}')

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(input()).toHaveValue('')

    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('offers to drop the type scope when a scoped search finds nothing', async () => {
    const { user } = renderPalette()

    await user.keyboard('{Control>}2{/Control}')
    await user.type(input(), 'okr')
    const empty = await screen.findByText(/empty\.scoped/)
    expect(empty.textContent).toContain('okr')

    await user.keyboard('{Enter}')

    await waitFor(() => expect(lastQuery()).toEqual(expect.objectContaining({ types: [] })))
  })
})

describe('CommandPalette index status (#1832)', () => {
  it('shows nothing while the index is current', () => {
    renderPalette()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('announces the build with counts while indexing', () => {
    vaultStatus = { isIndexing: true, indexBuilt: 120, indexTotal: 400 }
    renderPalette()
    expect(screen.getByRole('status').textContent).toMatch(/status\.indexing .*"done":120/)
  })

  it('falls back to the countless variant before the first beat arrives', () => {
    vaultStatus = { isIndexing: true, indexBuilt: undefined, indexTotal: undefined }
    renderPalette()
    expect(
      within(screen.getByRole('status')).getByText('searchPalette.status.indexingUnknown')
    ).toBeInTheDocument()
  })
})

describe('CommandPalette telemetry', () => {
  it('tracks the open once and search intent on the first keystroke only', async () => {
    const { user } = renderPalette()

    await user.type(input(), 'ab')

    const names = vi.mocked(trackTelemetry).mock.calls.map(([name]) => name)
    expect(names.filter((n) => n === 'command_palette_opened')).toHaveLength(1)
    expect(names.filter((n) => n === 'search_opened')).toHaveLength(1)
  })
})
