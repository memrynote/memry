import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PropertiesSettings } from './properties-section'
import { usePropertyDefinitions } from '@/hooks/use-property-definitions'
import { createMockApi } from '@tests/setup-dom'
import { toast } from 'sonner'

vi.mock('@/hooks/use-property-definitions', () => ({
  usePropertyDefinitions: vi.fn()
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
    expect(screen.getByText(/No property definitions yet/)).toBeInTheDocument()
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
    const { container } = render(<PropertiesSettings />)

    await userEvent.click(screen.getByText('Workflow'))
    // Built-in status category keys are translated at the display layer
    // (getStatusCategoryLabel), so the header shows the `notes` locale value
    // rather than the English label stored on the definition ('To do'). Option
    // values are user data and still render verbatim.
    const todoLabel = i18next.getFixedT(null, 'notes')('properties.statusCategories.todo')
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
})
