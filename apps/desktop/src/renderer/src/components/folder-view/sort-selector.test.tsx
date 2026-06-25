import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { SortSelector } from './sort-selector'
import type { OrderConfig } from '@memry/contracts/folder-view-api'

const builtInColumns = [
  { id: 'title', displayName: 'Title', type: 'string' },
  { id: 'created', displayName: 'Created', type: 'date' },
  { id: 'modified', displayName: 'Modified', type: 'date' },
  { id: 'folder', displayName: 'Folder', type: 'string' }
]

const properties = [
  { name: 'status', type: 'string', usageCount: 5 },
  { name: 'priority', type: 'string', usageCount: 3 }
]

describe('SortSelector', () => {
  it('renders a trigger button with sort icon', () => {
    const onSortingChange = vi.fn()
    render(
      <SortSelector
        order={undefined}
        availableProperties={properties}
        builtInColumns={builtInColumns}
        onSortingChange={onSortingChange}
      />
    )
    const button = screen.getByRole('button')
    expect(button).toBeDefined()
  })

  it('selects a property and calls onSortingChange with asc', () => {
    const onSortingChange = vi.fn()
    render(
      <SortSelector
        order={undefined}
        availableProperties={properties}
        builtInColumns={builtInColumns}
        onSortingChange={onSortingChange}
      />
    )

    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)

    const titleBtn = screen.getByText('Title')
    fireEvent.click(titleBtn)

    expect(onSortingChange).toHaveBeenCalledWith([{ property: 'title', direction: 'asc' }])
  })

  it('toggles direction when selecting same property', () => {
    const onSortingChange = vi.fn()
    const order: OrderConfig[] = [{ property: 'title', direction: 'asc' }]

    render(
      <SortSelector
        order={order}
        availableProperties={properties}
        builtInColumns={builtInColumns}
        onSortingChange={onSortingChange}
      />
    )

    const trigger = screen.getAllByRole('button')[0]
    fireEvent.click(trigger)

    const titleBtn = screen.getByText('Title')
    fireEvent.click(titleBtn)

    expect(onSortingChange).toHaveBeenCalledWith([{ property: 'title', direction: 'desc' }])
  })

  it('filters properties by search query', () => {
    const onSortingChange = vi.fn()
    render(
      <SortSelector
        order={undefined}
        availableProperties={properties}
        builtInColumns={builtInColumns}
        onSortingChange={onSortingChange}
      />
    )

    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)

    const searchInput = screen.getByPlaceholderText(/search/i)
    fireEvent.change(searchInput, { target: { value: 'status' } })

    expect(screen.getByText('Status')).toBeDefined()
    expect(screen.queryByText('Priority')).toBeFalsy()
  })

  it('clears sort when clicking clear button', () => {
    const onSortingChange = vi.fn()
    const order: OrderConfig[] = [{ property: 'title', direction: 'asc' }]

    render(
      <SortSelector
        order={order}
        availableProperties={properties}
        builtInColumns={builtInColumns}
        onSortingChange={onSortingChange}
      />
    )

    const trigger = screen.getAllByRole('button')[0]
    fireEvent.click(trigger)

    const clearBtn = screen.getByLabelText(/clear/i)
    fireEvent.click(clearBtn)

    expect(onSortingChange).toHaveBeenCalledWith([])
  })

  it('toggles direction from the direction button', () => {
    const onSortingChange = vi.fn()
    const order: OrderConfig[] = [{ property: 'title', direction: 'asc' }]

    render(
      <SortSelector
        order={order}
        availableProperties={properties}
        builtInColumns={builtInColumns}
        onSortingChange={onSortingChange}
      />
    )

    const trigger = screen.getAllByRole('button')[0]
    fireEvent.click(trigger)

    const directionBtn = screen.getByText(/A → Z/i)
    fireEvent.click(directionBtn)

    expect(onSortingChange).toHaveBeenCalledWith([{ property: 'title', direction: 'desc' }])
  })
})
