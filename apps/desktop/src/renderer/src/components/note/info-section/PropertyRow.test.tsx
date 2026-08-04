import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PropertyRow } from './PropertyRow'
import type { Property } from './types'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  addPropertyOption: vi.fn(),
  addStatusOption: vi.fn(),
  removePropertyOption: vi.fn(),
  isEnabled: vi.fn(() => false),
  setEnabled: vi.fn()
}))

vi.mock('@/hooks/use-calendar-properties', () => ({
  useCalendarProperties: () => ({
    isEnabled: mocks.isEnabled,
    setEnabled: mocks.setEnabled
  })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: { 'data-sortable': 'yes' },
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false
  })
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => '' } }
}))

vi.mock('@/hooks/use-projects-list', () => ({
  useProjectsList: () => ({
    projects: [{ id: 'p1', name: 'Alpha', color: '#f00', icon: null, archivedAt: null }],
    isLoading: false
  })
}))

vi.mock('@/hooks/use-property-definitions', () => ({
  usePropertyDefinitions: () => ({
    refresh: mocks.refresh,
    getDefinition: (name: string) => {
      if (name === 'Status') {
        return {
          options: JSON.stringify({
            categories: {
              todo: [{ value: 'todo', label: 'Todo', color: '#888' }],
              doing: [],
              done: []
            }
          })
        }
      }
      return {
        options: JSON.stringify([{ value: 'high', label: 'High', color: '#f00' }])
      }
    }
  })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    addPropertyOption: mocks.addPropertyOption,
    addStatusOption: mocks.addStatusOption,
    removePropertyOption: mocks.removePropertyOption
  }
}))

vi.mock('./editors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./editors')>()
  return {
    ProjectEditor: actual.ProjectEditor,
    RelationEditor: ({
      value,
      onChange
    }: {
      value: string[]
      onChange: (value: string[]) => void
    }) => (
      <div>
        <span>relation-editor:{value.join(',')}</span>
        <button type="button" onClick={() => onChange([])}>
          clear-relation
        </button>
      </div>
    ),
    TextEditor: ({
      value,
      onChange,
      onBlur
    }: {
      value: string
      onChange: (value: string) => void
      onBlur: () => void
    }) => (
      <input
        aria-label="text-editor"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
    ),
    NumberEditor: ({
      value,
      onChange,
      onBlur
    }: {
      value: number | null
      onChange: (value: number) => void
      onBlur: () => void
    }) => (
      <input
        aria-label="number-editor"
        value={value ?? ''}
        onChange={(event) => onChange(Number(event.target.value))}
        onBlur={onBlur}
      />
    ),
    CheckboxEditor: ({
      value,
      onChange
    }: {
      value: boolean
      onChange: (value: boolean) => void
    }) => (
      <input
        aria-label="checkbox-editor"
        type="checkbox"
        checked={value}
        onChange={(event) => onChange(event.target.checked)}
      />
    ),
    DateEditor: ({
      value,
      onChange,
      onBlur
    }: {
      value: Date | null
      onChange: (date: Date | null) => void
      onBlur: () => void
    }) => (
      <button
        type="button"
        onClick={() => onChange(new Date('2026-05-10T00:00:00Z'))}
        onBlur={onBlur}
      >
        date:{value?.toISOString() ?? 'none'}
      </button>
    ),
    UrlEditor: ({
      value,
      onChange,
      onBlur
    }: {
      value: string
      onChange: (value: string) => void
      onBlur: () => void
    }) => (
      <input
        aria-label="url-editor"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
    ),
    SelectEditor: ({
      options,
      onChange,
      onAddOption,
      onRemoveOption
    }: {
      options: Array<{ value: string }>
      onChange: (value: string) => void
      onAddOption: (option: { value: string; label: string }) => void
      onRemoveOption: (value: string) => void
    }) => (
      <div>
        <button type="button" onClick={() => onChange(options[0]?.value ?? 'high')}>
          select-editor
        </button>
        <button type="button" onClick={() => onAddOption({ value: 'low', label: 'Low' })}>
          add-option
        </button>
        <button type="button" onClick={() => onRemoveOption('high')}>
          remove-option
        </button>
      </div>
    ),
    MultiselectEditor: ({
      onChange,
      onAddOption
    }: {
      onChange: (value: string[]) => void
      onAddOption: (option: { value: string; label: string }) => void
    }) => (
      <div>
        <button type="button" onClick={() => onChange(['high'])}>
          multiselect-editor
        </button>
        <button type="button" onClick={() => onAddOption({ value: 'low', label: 'Low' })}>
          add-multi
        </button>
      </div>
    ),
    StatusEditor: ({
      onChange,
      onAddOption,
      onRemoveOption
    }: {
      onChange: (value: string) => void
      onAddOption: (category: 'todo', option: { value: string; label: string }) => void
      onRemoveOption: (value: string) => void
    }) => (
      <div>
        <button type="button" onClick={() => onChange('todo')}>
          status-editor
        </button>
        <button type="button" onClick={() => onAddOption('todo', { value: 'next', label: 'Next' })}>
          add-status
        </button>
        <button type="button" onClick={() => onRemoveOption('todo')}>
          remove-status
        </button>
      </div>
    )
  }
})

const property = (overrides: Partial<Property> = {}): Property => ({
  id: 'prop-1',
  name: 'Title',
  type: 'text',
  value: 'Draft',
  isCustom: true,
  ...overrides
})

// `@memry/i18n/renderer` is mocked module-wide above (t returns the key
// unchanged), so this is a plain alias — kept for parity with the other
// info-section test files that render behind a real i18n provider.
const renderWithI18n = render

describe('PropertyRow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.addPropertyOption.mockResolvedValue({ success: true })
    mocks.addStatusOption.mockResolvedValue({ success: true })
    mocks.removePropertyOption.mockResolvedValue({ success: true })
  })

  it('displays values, edits text and names, deletes custom rows, and shows drag handle', async () => {
    const onValueChange = vi.fn()
    const onNameChange = vi.fn()
    const onDelete = vi.fn()

    render(
      <PropertyRow
        property={property()}
        onValueChange={onValueChange}
        onNameChange={onNameChange}
        onDelete={onDelete}
        isSortable
      />
    )

    expect(screen.getByText('Draft')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Draft'))
    fireEvent.change(screen.getByLabelText('text-editor'), { target: { value: 'Updated' } })
    expect(onValueChange).toHaveBeenCalledWith('Updated')
    fireEvent.blur(screen.getByLabelText('text-editor'))

    fireEvent.click(screen.getByText('Title'))
    fireEvent.change(screen.getByLabelText('properties.editName'), { target: { value: 'Renamed' } })
    fireEvent.keyDown(screen.getByLabelText('properties.editName'), { key: 'Enter' })
    expect(onNameChange).toHaveBeenCalledWith('Renamed')

    fireEvent.mouseEnter(screen.getByText('Title').closest('div')!)
    expect(screen.getByLabelText('properties.dragAria: Title')).toBeInTheDocument()
    fireEvent.mouseEnter(screen.getByText('Title').closest('div')!.parentElement!)
    fireEvent.click(screen.getByLabelText('properties.delete: Title'))
    expect(onDelete).toHaveBeenCalled()
  })

  it('renders primitive editors and disabled name editing', () => {
    const onValueChange = vi.fn()
    const { rerender } = render(
      <PropertyRow
        property={property({ type: 'checkbox', value: false })}
        onValueChange={onValueChange}
      />
    )
    fireEvent.click(screen.getByLabelText('checkbox-editor'))
    expect(onValueChange).toHaveBeenCalledWith(true)

    rerender(
      <PropertyRow
        property={property({ type: 'number', value: 3 })}
        onValueChange={onValueChange}
        autoFocus
      />
    )
    fireEvent.change(screen.getByLabelText('number-editor'), { target: { value: '7' } })
    expect(onValueChange).toHaveBeenCalledWith(7)

    rerender(
      <PropertyRow
        property={property({ type: 'date', value: '2026-01-01T00:00:00Z' })}
        onValueChange={onValueChange}
        autoFocus
      />
    )
    fireEvent.click(screen.getByText(/date:/))
    expect(onValueChange).toHaveBeenCalledWith('2026-05-10T00:00:00.000Z')

    rerender(
      <PropertyRow
        property={property({ type: 'url', value: 'https://example.com' })}
        onValueChange={onValueChange}
        autoFocus
        disabled
      />
    )
    expect(screen.getByText('Title')).not.toHaveAttribute('role')
  })

  it('renders select, multiselect, and status editors with option mutations', async () => {
    const onValueChange = vi.fn()
    const { rerender } = render(
      <PropertyRow
        property={property({ name: 'Priority', type: 'select', value: 'high' })}
        onValueChange={onValueChange}
        autoFocus
      />
    )

    fireEvent.click(screen.getByText('select-editor'))
    expect(onValueChange).toHaveBeenCalledWith('high')
    fireEvent.click(screen.getByText('add-option'))
    fireEvent.click(screen.getByText('remove-option'))
    await waitFor(() => {
      expect(mocks.addPropertyOption).toHaveBeenCalledWith('Priority', {
        value: 'low',
        label: 'Low'
      })
    })

    rerender(
      <PropertyRow
        property={property({ name: 'Tags', type: 'multiselect', value: [] })}
        onValueChange={onValueChange}
        autoFocus
      />
    )
    fireEvent.click(screen.getByText('multiselect-editor'))
    expect(onValueChange).toHaveBeenCalledWith(['high'])
    fireEvent.click(screen.getByText('add-multi'))
    await waitFor(() => {
      expect(mocks.addPropertyOption).toHaveBeenCalledWith('Tags', { value: 'low', label: 'Low' })
    })

    rerender(
      <PropertyRow
        property={property({ name: 'Status', type: 'status', value: null })}
        onValueChange={onValueChange}
        autoFocus
      />
    )
    fireEvent.click(screen.getByText('status-editor'))
    expect(onValueChange).toHaveBeenCalledWith('todo')
    fireEvent.click(screen.getByText('add-status'))
    fireEvent.click(screen.getByText('remove-status'))
    await waitFor(() => {
      expect(mocks.addStatusOption).toHaveBeenCalledWith('Status', 'todo', {
        value: 'next',
        label: 'Next'
      })
      expect(mocks.refresh).toHaveBeenCalled()
    })
  })

  it('shows calendar toggle trigger only for date properties', () => {
    const onValueChange = vi.fn()

    const { rerender } = render(
      <PropertyRow
        property={property({ type: 'date', value: '2026-01-01T00:00:00Z' })}
        onValueChange={onValueChange}
      />
    )
    expect(screen.getByRole('button', { name: 'properties.showOnCalendar' })).toBeInTheDocument()

    rerender(
      <PropertyRow
        property={property({ type: 'text', value: 'hello' })}
        onValueChange={onValueChange}
      />
    )
    expect(
      screen.queryByRole('button', { name: 'properties.showOnCalendar' })
    ).not.toBeInTheDocument()
  })

  it('toggles calendar visibility in one click and reflects state', () => {
    const onValueChange = vi.fn()

    // OFF by default (mock isEnabled => false): aria-pressed false, click turns on
    const { rerender } = render(
      <PropertyRow
        property={property({ name: 'Deadline', type: 'date', value: '2026-01-01T00:00:00Z' })}
        onValueChange={onValueChange}
      />
    )
    const offBtn = screen.getByRole('button', { name: 'properties.showOnCalendar' })
    expect(offBtn).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(offBtn)
    expect(mocks.setEnabled).toHaveBeenCalledWith('Deadline', true)

    // ON: aria-pressed true, tooltip reflects state, click turns off
    mocks.isEnabled.mockReturnValue(true)
    rerender(
      <PropertyRow
        property={property({ name: 'Deadline', type: 'date', value: '2026-01-01T00:00:00Z' })}
        onValueChange={onValueChange}
      />
    )
    const onBtn = screen.getByRole('button', { name: 'properties.showOnCalendar' })
    expect(onBtn).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(onBtn)
    expect(mocks.setEnabled).toHaveBeenCalledWith('Deadline', false)
  })

  it('renders the project editor for a project property', () => {
    renderWithI18n(
      <PropertyRow
        property={{ id: '1', name: 'project', type: 'project', value: ['Alpha'], isCustom: true }}
        onValueChange={vi.fn()}
      />
    )

    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('does not let a project property be renamed', () => {
    renderWithI18n(
      <PropertyRow
        property={{ id: '1', name: 'project', type: 'project', value: [], isCustom: true }}
        onValueChange={vi.fn()}
        onNameChange={vi.fn()}
      />
    )

    expect(screen.getByTitle('project')).not.toHaveAttribute('role', 'button')
  })

  it('dispatches relation properties to RelationEditor with a normalized array value', () => {
    const onValueChange = vi.fn()

    const { rerender } = render(
      <PropertyRow
        property={property({
          name: 'Related',
          type: 'relation',
          value: ['memry://note/nte_1']
        })}
        onValueChange={onValueChange}
      />
    )
    expect(screen.getByText('relation-editor:memry://note/nte_1')).toBeInTheDocument()
    fireEvent.click(screen.getByText('clear-relation'))
    expect(onValueChange).toHaveBeenCalledWith([])

    // Non-array stored value (e.g. null on a freshly-added property) is
    // normalized to an empty array rather than passed through raw.
    rerender(
      <PropertyRow
        property={property({ name: 'Related', type: 'relation', value: null })}
        onValueChange={onValueChange}
      />
    )
    expect(screen.getByText('relation-editor:')).toBeInTheDocument()
  })
})
