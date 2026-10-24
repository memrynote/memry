import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SidebarSortMode } from '@memry/contracts/sidebar-sort'
import { SidebarSortPicker, type SidebarSortPickerProps } from './sidebar-sort-picker'

const labels = {
  manual: 'Manual',
  'name-asc': 'Name A-Z',
  'name-desc': 'Name Z-A',
  'modified-desc': 'Modified newest',
  'modified-asc': 'Modified oldest',
  'created-desc': 'Created newest',
  'created-asc': 'Created oldest',
  'count-desc': 'Count high',
  'count-asc': 'Count low'
} satisfies Record<SidebarSortMode, string>

const renderPicker = (overrides: Partial<SidebarSortPickerProps> = {}) => {
  const props: SidebarSortPickerProps = {
    surface: 'collections',
    mode: 'manual',
    onModeChange: vi.fn(),
    labels,
    triggerLabel: 'Sort Collections: Manual',
    ...overrides
  }
  render(<SidebarSortPicker {...props} />)
  return props
}

describe('SidebarSortPicker', () => {
  // Every surface that passes no view options keeps exactly its sort menu.
  it('renders only the sort modes when given no view options', async () => {
    const user = userEvent.setup()
    renderPicker({ surface: 'projects', triggerLabel: 'Sort Projects: Manual' })

    await user.click(screen.getByTestId('sidebar-sort-projects'))

    expect(screen.getAllByRole('listbox')).toHaveLength(1)
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Manual',
      'Name A-Z',
      'Name Z-A',
      'Created newest',
      'Created oldest'
    ])
  })

  it('lists the view options as their own group after the sort modes', async () => {
    const user = userEvent.setup()
    const onNotesFirst = vi.fn()
    const onShowFiles = vi.fn()
    const props = renderPicker({
      viewOptionsLabel: 'View options',
      viewOptions: [
        {
          id: 'notes-first',
          label: 'Notes before folders',
          checked: false,
          onCheckedChange: onNotesFirst
        },
        { id: 'show-files', label: 'Show files', checked: true, onCheckedChange: onShowFiles }
      ]
    })

    // The trigger keeps its name and hook: tests and e2e address it by these.
    const trigger = screen.getByTestId('sidebar-sort-collections')
    expect(trigger).toHaveAccessibleName('Sort Collections: Manual')
    await user.click(trigger)

    const group = screen.getByRole('listbox', { name: 'View options' })
    expect(group).toHaveAttribute('aria-multiselectable', 'true')
    const notesFirst = screen.getByTestId('sidebar-view-option-notes-first')
    const showFiles = screen.getByTestId('sidebar-view-option-show-files')
    expect(notesFirst).toHaveAttribute('aria-selected', 'false')
    expect(showFiles).toHaveAttribute('aria-selected', 'true')
    // The sort mode stays the one marked selected in its own list.
    expect(screen.getByRole('option', { name: 'Manual' })).toHaveAttribute('aria-selected', 'true')

    await user.click(notesFirst)
    expect(onNotesFirst).toHaveBeenCalledWith(true)
    // A toggle is not a sort mode, and the menu stays open for the next one.
    expect(props.onModeChange).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('sidebar-view-option-show-files'))
    expect(onShowFiles).toHaveBeenCalledWith(false)
  })
})
