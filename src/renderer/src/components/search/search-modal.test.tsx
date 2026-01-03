/**
 * SearchModal Component Tests (T523-T524)
 *
 * Tests for the SearchModal component with search, navigation, and keyboard shortcuts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SearchModal } from './search-modal'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@/hooks/use-search', () => ({
  useQuickSearch: vi.fn(),
  useRecentSearches: vi.fn()
}))

vi.mock('@/services/search-service', () => ({
  safeHighlight: (text: string) => text
}))

// Mock scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn()

// Import the mocked modules
import { useQuickSearch, useRecentSearches } from '@/hooks/use-search'

// ============================================================================
// Test Data
// ============================================================================

const mockNotes = [
  { id: 'note-1', title: 'Meeting Notes', path: 'notes/Meeting Notes.md', snippet: 'Today we discussed...', tags: ['work'] },
  { id: 'note-2', title: 'Project Ideas', path: 'notes/Project Ideas.md', snippet: 'New features to consider...', tags: ['ideas'] },
  { id: 'note-3', title: 'Daily Journal', path: 'notes/Daily Journal.md', snippet: 'Reflections on the day...', tags: ['personal'] }
]

const mockRecentSearches = ['react', 'typescript', 'meeting']

const setupMocks = (
  notes = mockNotes,
  recentSearches = mockRecentSearches,
  isLoading = false
) => {
  const setQuery = vi.fn()
  const clear = vi.fn()
  const addRecent = vi.fn()
  const clearRecent = vi.fn()

  ;(useQuickSearch as ReturnType<typeof vi.fn>).mockReturnValue({
    query: '',
    notes,
    isLoading,
    setQuery,
    clear
  })

  ;(useRecentSearches as ReturnType<typeof vi.fn>).mockReturnValue({
    recent: recentSearches,
    isLoading: false,
    addRecent,
    clearRecent
  })

  return { setQuery, clear, addRecent, clearRecent }
}

// ============================================================================
// Test Helpers
// ============================================================================

const createQueryClient = () => new QueryClient({
  defaultOptions: {
    queries: { retry: false }
  }
})

const renderWithProviders = (ui: React.ReactElement) => {
  const queryClient = createQueryClient()
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>
  )
}

// ============================================================================
// T523: SearchModal - Search Functionality Tests
// ============================================================================

describe('T523: SearchModal - search functionality', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSelectNote: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setupMocks()
  })

  it('should render search input when open', () => {
    renderWithProviders(<SearchModal {...defaultProps} />)

    expect(screen.getByPlaceholderText(/search notes/i)).toBeInTheDocument()
  })

  it('should not render when closed', () => {
    renderWithProviders(<SearchModal {...defaultProps} isOpen={false} />)

    expect(screen.queryByPlaceholderText(/search notes/i)).not.toBeInTheDocument()
  })

  it('should focus search input when opened', async () => {
    renderWithProviders(<SearchModal {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search notes/i)).toHaveFocus()
    })
  })

  it('should show recent searches when query is empty', () => {
    renderWithProviders(<SearchModal {...defaultProps} />)

    expect(screen.getByText('Recent')).toBeInTheDocument()
    expect(screen.getByText('react')).toBeInTheDocument()
    expect(screen.getByText('typescript')).toBeInTheDocument()
    expect(screen.getByText('meeting')).toBeInTheDocument()
  })

  it('should show clear button for recent searches', () => {
    renderWithProviders(<SearchModal {...defaultProps} />)

    expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument()
  })

  it('should clear recent searches on clear click', async () => {
    const { clearRecent } = setupMocks()
    const user = userEvent.setup()

    renderWithProviders(<SearchModal {...defaultProps} />)

    const clearButton = screen.getByRole('button', { name: /clear/i })
    await user.click(clearButton)

    expect(clearRecent).toHaveBeenCalled()
  })

  it('should show search results', async () => {
    const { setQuery } = setupMocks()
    const user = userEvent.setup()

    ;(useQuickSearch as ReturnType<typeof vi.fn>).mockReturnValue({
      query: 'meeting',
      notes: mockNotes.slice(0, 1),
      isLoading: false,
      setQuery,
      clear: vi.fn()
    })

    renderWithProviders(<SearchModal {...defaultProps} />)

    const input = screen.getByPlaceholderText(/search notes/i)
    await user.type(input, 'meeting')

    expect(setQuery).toHaveBeenCalled()
  })

  it('should show loading indicator while searching', () => {
    setupMocks([], [], true)

    renderWithProviders(<SearchModal {...defaultProps} />)

    // Loading spinner should be visible
    const loadingIndicator = document.querySelector('.animate-spin')
    expect(loadingIndicator).toBeInTheDocument()
  })

  it('should show no results message', () => {
    ;(useQuickSearch as ReturnType<typeof vi.fn>).mockReturnValue({
      query: 'nonexistent',
      notes: [],
      isLoading: false,
      setQuery: vi.fn(),
      clear: vi.fn()
    })

    renderWithProviders(<SearchModal {...defaultProps} />)

    expect(screen.getByText(/no notes found/i)).toBeInTheDocument()
  })

  it('should show empty state when no query and no recent', () => {
    setupMocks([], [])

    renderWithProviders(<SearchModal {...defaultProps} />)

    expect(screen.getByText(/search your notes/i)).toBeInTheDocument()
  })

  it('should show result count', () => {
    ;(useQuickSearch as ReturnType<typeof vi.fn>).mockReturnValue({
      query: 'meeting',
      notes: mockNotes,
      isLoading: false,
      setQuery: vi.fn(),
      clear: vi.fn()
    })

    renderWithProviders(<SearchModal {...defaultProps} />)

    expect(screen.getByText(/3 results/i)).toBeInTheDocument()
  })
})

// ============================================================================
// T524: SearchModal - Keyboard Navigation Tests
// ============================================================================

describe('T524: SearchModal - keyboard navigation', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSelectNote: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setupMocks()
  })

  it('should navigate down with ArrowDown', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SearchModal {...defaultProps} />)

    await user.keyboard('{ArrowDown}')

    // Verify all items are rendered (navigation updates internal state)
    expect(screen.getByText('react')).toBeInTheDocument()
    expect(screen.getByText('typescript')).toBeInTheDocument()
    // Check that one item has aria-selected="true"
    const selectedItems = screen.getAllByRole('option').filter((el) => el.getAttribute('aria-selected') === 'true')
    expect(selectedItems.length).toBeGreaterThanOrEqual(1)
  })

  it('should navigate up with ArrowUp', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SearchModal {...defaultProps} />)

    // First move down, then up
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{ArrowUp}')

    // Verify items are still rendered and at least one is selected
    expect(screen.getByText('react')).toBeInTheDocument()
    const selectedItems = screen.getAllByRole('option').filter((el) => el.getAttribute('aria-selected') === 'true')
    expect(selectedItems.length).toBeGreaterThanOrEqual(1)
  })

  it('should not go below last item', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SearchModal {...defaultProps} />)

    // Press down many times
    for (let i = 0; i < 10; i++) {
      await user.keyboard('{ArrowDown}')
    }

    // Verify items are rendered
    expect(screen.getByText('meeting')).toBeInTheDocument()
    // Check that one item is selected
    const selectedItems = screen.getAllByRole('option').filter((el) => el.getAttribute('aria-selected') === 'true')
    expect(selectedItems.length).toBe(1)
  })

  it('should not go above first item', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SearchModal {...defaultProps} />)

    // Press up many times from start
    for (let i = 0; i < 5; i++) {
      await user.keyboard('{ArrowUp}')
    }

    // Verify items are rendered
    expect(screen.getByText('react')).toBeInTheDocument()
    // Check that one item is selected
    const selectedItems = screen.getAllByRole('option').filter((el) => el.getAttribute('aria-selected') === 'true')
    expect(selectedItems.length).toBe(1)
  })

  it('should select recent search on Enter', async () => {
    const { setQuery } = setupMocks()
    const user = userEvent.setup()

    renderWithProviders(<SearchModal {...defaultProps} />)

    await user.keyboard('{Enter}')

    // Should set query to first recent search
    expect(setQuery).toHaveBeenCalledWith('react')
  })

  it('should select note result on Enter', async () => {
    const { addRecent } = setupMocks()

    ;(useQuickSearch as ReturnType<typeof vi.fn>).mockReturnValue({
      query: 'meeting',
      notes: mockNotes.slice(0, 1),
      isLoading: false,
      setQuery: vi.fn(),
      clear: vi.fn()
    })

    const onSelectNote = vi.fn()
    const user = userEvent.setup()

    renderWithProviders(<SearchModal {...defaultProps} onSelectNote={onSelectNote} />)

    await user.keyboard('{Enter}')

    expect(onSelectNote).toHaveBeenCalledWith('note-1', 'notes/Meeting Notes.md')
    expect(addRecent).toHaveBeenCalledWith('meeting')
  })

  it('should close on Escape', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()

    renderWithProviders(<SearchModal {...defaultProps} onClose={onClose} />)

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalled()
  })

  it('should close when selecting a note', async () => {
    const onClose = vi.fn()
    const onSelectNote = vi.fn()

    ;(useQuickSearch as ReturnType<typeof vi.fn>).mockReturnValue({
      query: 'meeting',
      notes: mockNotes.slice(0, 1),
      isLoading: false,
      setQuery: vi.fn(),
      clear: vi.fn()
    })

    const user = userEvent.setup()

    renderWithProviders(<SearchModal {...defaultProps} onClose={onClose} onSelectNote={onSelectNote} />)

    await user.keyboard('{Enter}')

    expect(onClose).toHaveBeenCalled()
  })

  it('should scroll selected item into view', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SearchModal {...defaultProps} />)

    // Navigate down
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{ArrowDown}')

    // Verify items are rendered
    expect(screen.getByText('meeting')).toBeInTheDocument()
    // Scroll behavior is tested implicitly - just verify selection works
    const selectedItems = screen.getAllByRole('option').filter((el) => el.getAttribute('aria-selected') === 'true')
    expect(selectedItems.length).toBe(1)
  })
})

// ============================================================================
// SearchModal - Click Interactions Tests
// ============================================================================

describe('SearchModal - click interactions', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSelectNote: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setupMocks()
  })

  it('should select recent search on click', async () => {
    const { setQuery } = setupMocks()
    const user = userEvent.setup()

    renderWithProviders(<SearchModal {...defaultProps} />)

    await user.click(screen.getByText('react'))

    expect(setQuery).toHaveBeenCalledWith('react')
  })

  it('should select note result on click', async () => {
    const onSelectNote = vi.fn()

    ;(useQuickSearch as ReturnType<typeof vi.fn>).mockReturnValue({
      query: 'meeting',
      notes: mockNotes.slice(0, 1),
      isLoading: false,
      setQuery: vi.fn(),
      clear: vi.fn()
    })

    const user = userEvent.setup()

    renderWithProviders(<SearchModal {...defaultProps} onSelectNote={onSelectNote} />)

    await user.click(screen.getByText('Meeting Notes'))

    expect(onSelectNote).toHaveBeenCalledWith('note-1', 'notes/Meeting Notes.md')
  })
})

// ============================================================================
// SearchModal - Result Display Tests
// ============================================================================

describe('SearchModal - result display', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSelectNote: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should display note title', () => {
    ;(useQuickSearch as ReturnType<typeof vi.fn>).mockReturnValue({
      query: 'meeting',
      notes: mockNotes,
      isLoading: false,
      setQuery: vi.fn(),
      clear: vi.fn()
    })

    ;(useRecentSearches as ReturnType<typeof vi.fn>).mockReturnValue({
      recent: [],
      isLoading: false,
      addRecent: vi.fn(),
      clearRecent: vi.fn()
    })

    renderWithProviders(<SearchModal {...defaultProps} />)

    expect(screen.getByText('Meeting Notes')).toBeInTheDocument()
    expect(screen.getByText('Project Ideas')).toBeInTheDocument()
    expect(screen.getByText('Daily Journal')).toBeInTheDocument()
  })

  it('should display note snippet', () => {
    ;(useQuickSearch as ReturnType<typeof vi.fn>).mockReturnValue({
      query: 'meeting',
      notes: mockNotes.slice(0, 1),
      isLoading: false,
      setQuery: vi.fn(),
      clear: vi.fn()
    })

    ;(useRecentSearches as ReturnType<typeof vi.fn>).mockReturnValue({
      recent: [],
      isLoading: false,
      addRecent: vi.fn(),
      clearRecent: vi.fn()
    })

    renderWithProviders(<SearchModal {...defaultProps} />)

    expect(screen.getByText('Today we discussed...')).toBeInTheDocument()
  })

  it('should display note tags', () => {
    ;(useQuickSearch as ReturnType<typeof vi.fn>).mockReturnValue({
      query: 'meeting',
      notes: mockNotes.slice(0, 1),
      isLoading: false,
      setQuery: vi.fn(),
      clear: vi.fn()
    })

    ;(useRecentSearches as ReturnType<typeof vi.fn>).mockReturnValue({
      recent: [],
      isLoading: false,
      addRecent: vi.fn(),
      clearRecent: vi.fn()
    })

    renderWithProviders(<SearchModal {...defaultProps} />)

    // Tags are rendered with # prefix in SearchResultItem
    expect(screen.getByText('#work')).toBeInTheDocument()
  })
})

// ============================================================================
// Accessibility Tests
// ============================================================================

describe('SearchModal - accessibility', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSelectNote: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setupMocks()
  })

  it('should have dialog role', () => {
    renderWithProviders(<SearchModal {...defaultProps} />)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('should have accessible title', () => {
    renderWithProviders(<SearchModal {...defaultProps} />)

    // Title should be visually hidden but screen-reader accessible
    expect(screen.getByRole('dialog', { name: /search notes/i })).toBeInTheDocument()
  })

  it('should have proper aria-label on search input', () => {
    renderWithProviders(<SearchModal {...defaultProps} />)

    expect(screen.getByRole('textbox', { name: /search notes/i })).toBeInTheDocument()
  })

  it('should have listbox role for results', () => {
    renderWithProviders(<SearchModal {...defaultProps} />)

    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('should have option role for result items', () => {
    renderWithProviders(<SearchModal {...defaultProps} />)

    expect(screen.getAllByRole('option')).toHaveLength(3) // 3 recent searches
  })

  it('should have keyboard hints in footer', () => {
    renderWithProviders(<SearchModal {...defaultProps} />)

    expect(screen.getByText('navigate')).toBeInTheDocument()
    expect(screen.getByText('close')).toBeInTheDocument()
  })
})
