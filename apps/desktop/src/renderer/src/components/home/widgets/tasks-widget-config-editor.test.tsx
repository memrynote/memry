import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TasksWidgetConfigEditor } from './tasks-widget-config-editor'

let mockSavedFilters: Array<{ id: string; name: string }> = []

vi.mock('@/hooks/use-task-filters', () => ({
  useSavedFilters: () => ({ savedFilters: mockSavedFilters })
}))

describe('TasksWidgetConfigEditor', () => {
  beforeEach(() => {
    mockSavedFilters = [
      { id: 'sf1', name: 'This week' },
      { id: 'sf2', name: 'Overdue' }
    ]
  })

  it('renders the Today default plus one option per saved filter', () => {
    render(<TasksWidgetConfigEditor config={{}} onChange={vi.fn()} />)
    expect(screen.getByRole('option', { name: 'Today' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'This week' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Overdue' })).toBeInTheDocument()
  })

  it('writes savedFilterId on change and clears it for the Today option', () => {
    const onChange = vi.fn()
    render(<TasksWidgetConfigEditor config={{ dateRange: 'today' }} onChange={onChange} />)
    const select = screen.getByRole('combobox')
    fireEvent.change(select, { target: { value: 'sf2' } })
    expect(onChange).toHaveBeenCalledWith({ dateRange: 'today', savedFilterId: 'sf2' })
    fireEvent.change(select, { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith({ dateRange: 'today', savedFilterId: undefined })
  })

  it('shows the hint when there are no saved filters', () => {
    mockSavedFilters = []
    render(<TasksWidgetConfigEditor config={{}} onChange={vi.fn()} />)
    expect(screen.getByText('Star filters on the Tasks page to use them here')).toBeInTheDocument()
  })
})
