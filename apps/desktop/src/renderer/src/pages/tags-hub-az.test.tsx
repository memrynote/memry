import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TagsHubPage } from './tags-hub'

const tag = (name: string, count: number, sortOrder = 0) => ({
  tag: name,
  color: 'blue',
  icon: null,
  count,
  sortOrder
})

const hub = {
  categories: [
    {
      id: 'cat-1',
      name: 'Work',
      sortOrder: 0,
      tags: [tag('meetings', 3), tag('Zeta', 2, 1)]
    },
    { id: 'cat-2', name: 'Books', sortOrder: 1, tags: [tag('éclair', 7)] }
  ],
  uncategorized: [tag('apple', 1), tag('item 10', 1), tag('item 2', 4)],
  isLoading: false,
  error: null as string | null,
  createCategory: vi.fn(),
  renameCategory: vi.fn(),
  deleteCategory: vi.fn(),
  createTag: vi.fn(),
  reorder: vi.fn()
}

const mocks = vi.hoisted(() => ({
  openSidebarItem: vi.fn(),
  dispatch: vi.fn(),
  getTab: vi.fn()
}))

vi.mock('@/hooks/use-tag-categories', () => ({ useTagCategories: () => hub }))
vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: mocks.openSidebarItem })
}))
vi.mock('@/features/tag-fields/use-tag-schemas', () => ({
  useTagSchemas: () => ({ data: undefined, isLoading: false }),
  useResolvedTag: () => null,
  resolveTag: () => null,
  tagHasFields: () => false,
  useEditTagSchema: () => vi.fn()
}))
// The tab context is the real storage seam for view state: a tab's saved
// `viewState` seeds the page and every choice is dispatched back to it.
vi.mock('@/contexts/tabs', () => ({
  useTabActionsOptional: () => ({ dispatch: mocks.dispatch, getTab: mocks.getTab })
}))
vi.mock('@/contexts/tabs/tab-identity', () => ({
  useTabIdentity: () => ({ tabId: 'tab-1', groupId: 'group-1', entityId: undefined })
}))

/** Chips carry `title="<tag> (<count>)"`, which nothing else on the page does. */
const chipTitles = (): string[] =>
  screen.queryAllByTitle(/\(\d+\)$/).map((el) => el.getAttribute('title') ?? '')

const viewToggle = (name: RegExp): HTMLElement => screen.getByRole('radio', { name })

describe('TagsHubPage A–Z view', () => {
  beforeEach(() => {
    mocks.dispatch.mockClear()
    mocks.getTab.mockReset()
    mocks.getTab.mockReturnValue({ id: 'tab-1', viewState: undefined })
  })

  it('opens on Categories and offers the A–Z toggle', () => {
    render(<TagsHubPage />)

    expect(viewToggle(/categories/i)).toBeChecked()
    expect(viewToggle(/a–z/i)).not.toBeChecked()
    expect(screen.getByText('Work')).toBeInTheDocument()
  })

  it('shows every tag once, alphabetically, with its count, and no category blocks', async () => {
    render(<TagsHubPage />)

    await userEvent.click(viewToggle(/a–z/i))

    expect(chipTitles()).toEqual([
      'apple (1)',
      'éclair (7)',
      'item 2 (4)',
      'item 10 (1)',
      'meetings (3)',
      'Zeta (2)'
    ])
    expect(screen.getByText('All tags')).toBeInTheDocument()
    expect(screen.queryByText('Work')).not.toBeInTheDocument()
    expect(screen.queryByText('Uncategorized')).not.toBeInTheDocument()
  })

  it('offers no drag handles or sortable chips while the list is A–Z', async () => {
    const { container } = render(<TagsHubPage />)
    expect(screen.getAllByRole('button', { name: /drag to reorder category/i })).not.toHaveLength(0)

    await userEvent.click(viewToggle(/a–z/i))

    expect(screen.queryByRole('button', { name: /drag to reorder category/i })).toBeNull()
    expect(container.querySelector('[aria-roledescription="sortable"]')).toBeNull()
  })

  it('opens a tag from the A–Z list like the categories view does', async () => {
    render(<TagsHubPage />)
    await userEvent.click(viewToggle(/a–z/i))

    await userEvent.click(screen.getByTitle('éclair (7)'))

    expect(mocks.openSidebarItem).toHaveBeenCalledWith({
      type: 'tag',
      title: 'éclair',
      path: '/tags/éclair',
      entityId: 'éclair'
    })
  })

  it('filters the A–Z list with the search box and shows the empty state', async () => {
    render(<TagsHubPage />)
    await userEvent.click(viewToggle(/a–z/i))

    const search = screen.getByRole('textbox', { name: /search/i })
    await userEvent.type(search, 'item')
    expect(chipTitles()).toEqual(['item 2 (4)', 'item 10 (1)'])
    expect(
      within(screen.getByText('All tags').closest('section') as HTMLElement).getByText('2')
    ).toBeInTheDocument()

    await userEvent.clear(search)
    await userEvent.type(search, 'nothing-matches')
    expect(chipTitles()).toEqual([])
    expect(screen.getByText(/no categories or tags match/i)).toBeInTheDocument()
  })

  it('returns to the categories layout when toggled back, and keeps the choice selected', async () => {
    render(<TagsHubPage />)
    await userEvent.click(viewToggle(/a–z/i))

    // Pressing the selected view again must not leave the page with no view.
    await userEvent.click(viewToggle(/a–z/i))
    expect(viewToggle(/a–z/i)).toBeChecked()

    await userEvent.click(viewToggle(/categories/i))
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.queryByText('All tags')).not.toBeInTheDocument()
  })

  it('saves the chosen view to the tab state', async () => {
    render(<TagsHubPage />)

    await userEvent.click(viewToggle(/a–z/i))

    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'SAVE_TAB_STATE',
      payload: { tabId: 'tab-1', groupId: 'group-1', viewState: { tagsHubView: 'az' } }
    })
  })

  it('restores A–Z from the saved tab state', () => {
    mocks.getTab.mockReturnValue({ id: 'tab-1', viewState: { tagsHubView: 'az' } })

    render(<TagsHubPage />)

    expect(viewToggle(/a–z/i)).toBeChecked()
    expect(chipTitles()).toHaveLength(6)
  })

  it('falls back to Categories for tab state with no view or an unknown one', () => {
    mocks.getTab.mockReturnValue({ id: 'tab-1', viewState: { tagsHubView: 'grid' } })

    render(<TagsHubPage />)

    expect(viewToggle(/categories/i)).toBeChecked()
    expect(screen.getByText('Work')).toBeInTheDocument()
  })
})
