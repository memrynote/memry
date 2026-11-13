import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getFixedT } from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PropertiesSettings } from './properties-section'
import { usePropertyDefinitions } from '@/hooks/use-property-definitions'
import { createMockApi } from '@tests/setup-dom'
import { renderWithProviders as render } from '@tests/utils/render'
import { QueryClient } from '@tanstack/react-query'
import { APP_QUERY_DEFAULT_OPTIONS } from '@/lib/query-client-options'
import { toast } from 'sonner'

vi.mock('@/hooks/use-property-definitions', () => ({
  usePropertyDefinitions: vi.fn()
}))

const openTab = vi.fn()
const closeSettings = vi.fn()

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab })
}))

vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ close: closeSettings })
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

const usePropertyDefinitionsMock = vi.mocked(usePropertyDefinitions)

const definitions = [
  {
    name: 'Stage',
    type: 'select',
    options: JSON.stringify([
      { value: 'Draft', color: 'blue' },
      { value: 'Review', color: 'purple' }
    ]),
    defaultValue: null,
    color: null
  },
  {
    name: 'Workflow',
    type: 'status',
    options: JSON.stringify({
      categories: {
        todo: { label: 'To do', options: [{ value: 'Backlog', color: 'gray' }] },
        in_progress: { label: 'Doing', options: [{ value: 'In review', color: 'orange' }] },
        done: { label: 'Done', options: [{ value: 'Shipped', color: 'green' }] }
      }
    }),
    defaultValue: null,
    color: null
  },
  {
    name: 'Plain text',
    type: 'text',
    options: null,
    defaultValue: null,
    color: null
  },
  {
    name: 'rating',
    type: 'number',
    options: null,
    defaultValue: null,
    color: null
  }
]

describe('PropertiesSettings', () => {
  const refresh = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    refresh.mockResolvedValue(undefined)

    const api = createMockApi()
    api.notes.renamePropertyOption = vi.fn().mockResolvedValue({ success: true })
    api.notes.removePropertyOption = vi.fn().mockResolvedValue({ success: true })
    api.notes.updateOptionColor = vi.fn().mockResolvedValue({ success: true })
    api.notes.addPropertyOption = vi.fn().mockResolvedValue({ success: true })
    api.notes.addStatusOption = vi.fn().mockResolvedValue({ success: true })
    api.notes.deletePropertyDefinition = vi.fn().mockResolvedValue({ success: true })
    api.notes.getPropertyUsage = vi.fn().mockResolvedValue([
      { name: 'Plain text', noteCount: 2, mismatchCount: 0 },
      { name: 'rating', noteCount: 2, mismatchCount: 1 }
    ])
    api.notes.listNotesWithProperty = vi.fn().mockResolvedValue([])
    ;(window as Window & { api: unknown }).api = api

    usePropertyDefinitionsMock.mockReturnValue({
      definitions,
      isLoading: false,
      error: null,
      refresh,
      getDefinition: vi.fn(),
      createDefinition: vi.fn(),
      updateDefinition: vi.fn()
    })
  })

  it('renders loading, error, and empty states', () => {
    usePropertyDefinitionsMock.mockReturnValueOnce({
      definitions: [],
      isLoading: true,
      error: null,
      refresh,
      getDefinition: vi.fn(),
      createDefinition: vi.fn(),
      updateDefinition: vi.fn()
    })
    const { rerender } = render(<PropertiesSettings />)
    expect(screen.getByText('Loading properties...')).toBeInTheDocument()

    usePropertyDefinitionsMock.mockReturnValueOnce({
      definitions: [],
      isLoading: false,
      error: 'No database',
      refresh,
      getDefinition: vi.fn(),
      createDefinition: vi.fn(),
      updateDefinition: vi.fn()
    })
    rerender(<PropertiesSettings />)
    expect(screen.getByText('No database')).toBeInTheDocument()

    usePropertyDefinitionsMock.mockReturnValueOnce({
      definitions: [],
      isLoading: false,
      error: null,
      refresh,
      getDefinition: vi.fn(),
      createDefinition: vi.fn(),
      updateDefinition: vi.fn()
    })
    rerender(<PropertiesSettings />)
    expect(screen.getByText(/No properties yet/)).toBeInTheDocument()
  })

  it('filters definitions and shows the no-match state', async () => {
    render(<PropertiesSettings />)

    await userEvent.type(screen.getByPlaceholderText('Filter properties...'), 'missing')

    expect(screen.getByText('No properties matching "missing"')).toBeInTheDocument()
  })

  it('manages select options through rename, remove, color, and add actions', async () => {
    const api = window.api
    render(<PropertiesSettings />)

    await userEvent.click(screen.getByText('Stage'))
    expect(screen.getByText('Draft')).toBeInTheDocument()

    await userEvent.click(screen.getAllByTitle('Rename')[0])
    const editInput = screen.getByDisplayValue('Draft')
    await userEvent.clear(editInput)
    await userEvent.type(editInput, 'Idea')
    fireEvent.keyDown(editInput, { key: 'Enter' })

    expect(api.notes.renamePropertyOption).toHaveBeenCalledWith('Stage', 'Draft', 'Idea')

    await userEvent.click(screen.getAllByTitle('Remove')[0])
    expect(api.notes.removePropertyOption).toHaveBeenCalledWith('Stage', 'Draft')

    await userEvent.click(screen.getAllByTitle('Change color')[0])
    expect(screen.getByText('Change color for "Draft"')).toBeInTheDocument()
    await userEvent.click(screen.getByTitle('rose'))
    expect(api.notes.updateOptionColor).toHaveBeenCalledWith('Stage', 'Draft', 'rose')

    await userEvent.click(screen.getByText('Add option'))
    await userEvent.type(screen.getByPlaceholderText('Option name'), 'Ready')
    fireEvent.keyDown(screen.getByPlaceholderText('Option name'), { key: 'Enter' })

    expect(api.notes.addPropertyOption).toHaveBeenCalledWith('Stage', {
      value: 'Ready',
      color: expect.any(String)
    })
    expect(refresh).toHaveBeenCalled()
  })

  it('renders status categories and adds a category option', async () => {
    const api = window.api
    const { container: _container } = render(<PropertiesSettings />)

    await userEvent.click(screen.getByText('Workflow'))
    // Built-in status category keys are translated at the display layer
    // (getStatusCategoryLabel), so the header shows the `notes` locale value
    // rather than the English label stored on the definition ('To do'). Option
    // values are user data and still render verbatim.
    const todoLabel = getFixedT(null, 'notes')('properties.statusCategories.todo')
    expect(todoLabel).toBe('To-do')
    expect(screen.getByText(todoLabel)).toBeInTheDocument()
    expect(screen.getByText('Backlog')).toBeInTheDocument()

    const todoHeader = screen.getByText(todoLabel).closest('div')
    expect(todoHeader).not.toBeNull()
    const addButton = todoHeader?.querySelector('button')
    expect(addButton).not.toBeNull()

    await userEvent.click(addButton as HTMLButtonElement)
    await userEvent.type(screen.getByPlaceholderText('Option name'), 'Next')
    fireEvent.keyDown(screen.getByPlaceholderText('Option name'), { key: 'Enter' })

    expect(api.notes.addStatusOption).toHaveBeenCalledWith('Workflow', 'todo', {
      value: 'Next',
      color: expect.any(String)
    })
  })

  it('surfaces option mutation failures through toasts', async () => {
    const api = window.api
    api.notes.renamePropertyOption = vi.fn().mockRejectedValue(new Error('rename exploded'))

    render(<PropertiesSettings />)

    await userEvent.click(screen.getByText('Stage'))
    await userEvent.click(screen.getAllByTitle('Rename')[0])
    const editInput = screen.getByDisplayValue('Draft')
    await userEvent.clear(editInput)
    await userEvent.type(editInput, 'Idea')
    fireEvent.keyDown(editInput, { key: 'Enter' })

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('rename exploded'))
  })

  it('lists text properties with the notes that use them, and opens a note from the list', async () => {
    const api = window.api
    api.notes.listNotesWithProperty = vi.fn().mockResolvedValue([
      { id: 'n-book', title: 'Dune', path: 'Books/Dune.md', emoji: null, mismatch: false },
      { id: 'n-film', title: 'Arrival', path: 'Films/Arrival.md', emoji: null, mismatch: false }
    ])
    render(<PropertiesSettings />)

    const row = screen.getByText('Plain text').closest('div') as HTMLElement
    expect(await within(row.parentElement as HTMLElement).findByText('2 notes')).toBeInTheDocument()
    // Deleting a text definition leaves the notes' values in place, so the
    // next index pass would bring it back; the row offers no delete.
    expect(screen.queryByRole('button', { name: 'Actions for Plain text' })).toBeNull()

    await userEvent.click(screen.getByText('Plain text'))
    expect(api.notes.listNotesWithProperty).toHaveBeenCalledWith('Plain text')
    expect(screen.queryByText('Add option')).toBeNull()

    await userEvent.click(await screen.findByText('Arrival'))
    expect(closeSettings).toHaveBeenCalled()
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'n-film', title: 'Arrival' })
    )
  })

  it('flags notes whose value does not match the property type', async () => {
    const api = window.api
    api.notes.listNotesWithProperty = vi.fn().mockResolvedValue([
      { id: 'n-book', title: 'Dune', path: 'Dune.md', emoji: null, mismatch: false },
      { id: 'n-film', title: 'Arrival', path: 'Arrival.md', emoji: null, mismatch: true }
    ])
    render(<PropertiesSettings />)

    expect(await screen.findByText("Values that don't match Number: 1")).toBeInTheDocument()

    await userEvent.click(screen.getByText('rating'))
    const film = (await screen.findByText('Arrival')).closest('button') as HTMLElement
    expect(within(film).getByText("Doesn't match Number")).toBeInTheDocument()
    const book = screen.getByText('Dune').closest('button') as HTMLElement
    expect(within(book).queryByText("Doesn't match Number")).toBeNull()
  })

  it('reads note counts again each time the section opens', async () => {
    const api = window.api
    const queryClient = new QueryClient({ defaultOptions: APP_QUERY_DEFAULT_OPTIONS })
    const first = render(<PropertiesSettings />, { queryClient })
    const row = () => screen.getByText('Plain text').closest('div')?.parentElement as HTMLElement
    expect(await within(row()).findByText('2 notes')).toBeInTheDocument()
    first.unmount()

    api.notes.getPropertyUsage = vi
      .fn()
      .mockResolvedValue([{ name: 'Plain text', noteCount: 3, mismatchCount: 0 }])
    render(<PropertiesSettings />, { queryClient })

    expect(await within(row()).findByText('3 notes')).toBeInTheDocument()
  })
})
