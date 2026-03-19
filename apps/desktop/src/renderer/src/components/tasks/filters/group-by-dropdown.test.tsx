import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { GroupByDropdown } from './group-by-dropdown'
import type { TaskSort } from '@/data/tasks-data'
import { defaultSort } from '@/data/tasks-data'

const renderGroupByDropdown = (
  overrides: Partial<{ sort: TaskSort; onChange: (s: TaskSort) => void }> = {}
) => {
  const onChange = overrides.onChange ?? vi.fn()
  const sort = overrides.sort ?? defaultSort
  return { onChange, ...render(<GroupByDropdown sort={sort} onChange={onChange} />) }
}

describe('GroupByDropdown', () => {
  it('renders the group by trigger button', () => {
    renderGroupByDropdown()
    expect(screen.getByRole('button', { name: /group by/i })).toBeInTheDocument()
  })

  it('opens the dropdown popover on click', () => {
    renderGroupByDropdown()
    fireEvent.click(screen.getByRole('button', { name: /group by/i }))
    expect(screen.getByText('Due date')).toBeInTheDocument()
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('Created')).toBeInTheDocument()
    expect(screen.getByText('Title')).toBeInTheDocument()
    expect(screen.getByText('Project')).toBeInTheDocument()
  })

  it('shows the default field as selected', () => {
    renderGroupByDropdown({ sort: { field: 'dueDate', direction: 'asc' } })
    fireEvent.click(screen.getByRole('button', { name: /group by/i }))
    const dueDateButton = screen.getByText('Due date').closest('button')!
    expect(dueDateButton.className).toMatch(/bg-accent/)
  })

  it('calls onChange with the new field when a different group is selected', () => {
    const onChange = vi.fn()
    renderGroupByDropdown({ sort: { field: 'dueDate', direction: 'asc' }, onChange })
    fireEvent.click(screen.getByRole('button', { name: /group by/i }))
    fireEvent.click(screen.getByText('Priority'))
    expect(onChange).toHaveBeenCalledWith({ field: 'priority', direction: 'asc' })
  })

  it('shows direction toggle arrows for the selected field', () => {
    renderGroupByDropdown({ sort: { field: 'priority', direction: 'asc' } })
    fireEvent.click(screen.getByRole('button', { name: /group by/i }))
    expect(screen.getByRole('button', { name: /ascending/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /descending/i })).toBeInTheDocument()
  })

  it('calls onChange with desc when descending arrow is clicked', () => {
    const onChange = vi.fn()
    renderGroupByDropdown({ sort: { field: 'dueDate', direction: 'asc' }, onChange })
    fireEvent.click(screen.getByRole('button', { name: /group by/i }))
    fireEvent.click(screen.getByRole('button', { name: /descending/i }))
    expect(onChange).toHaveBeenCalledWith({ field: 'dueDate', direction: 'desc' })
  })

  it('calls onChange with asc when ascending arrow is clicked', () => {
    const onChange = vi.fn()
    renderGroupByDropdown({ sort: { field: 'priority', direction: 'desc' }, onChange })
    fireEvent.click(screen.getByRole('button', { name: /group by/i }))
    fireEvent.click(screen.getByRole('button', { name: /ascending/i }))
    expect(onChange).toHaveBeenCalledWith({ field: 'priority', direction: 'asc' })
  })

  it('resets to different field when clicking another option', () => {
    const onChange = vi.fn()
    renderGroupByDropdown({ sort: { field: 'title', direction: 'desc' }, onChange })
    fireEvent.click(screen.getByRole('button', { name: /group by/i }))
    fireEvent.click(screen.getByText('Priority'))
    expect(onChange).toHaveBeenCalledWith({ field: 'priority', direction: 'desc' })
  })

  it('shows direction arrows only once (for active selection)', () => {
    renderGroupByDropdown({ sort: { field: 'dueDate', direction: 'asc' } })
    fireEvent.click(screen.getByRole('button', { name: /group by/i }))
    const arrows = screen.getAllByRole('button', { name: /ascending|descending/i })
    expect(arrows).toHaveLength(2)
  })

  it('shows all six group by options as buttons', () => {
    renderGroupByDropdown()
    fireEvent.click(screen.getByRole('button', { name: /group by/i }))
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('Due date')).toBeInTheDocument()
    expect(screen.getByText('Created')).toBeInTheDocument()
    expect(screen.getByText('Title')).toBeInTheDocument()
    expect(screen.getByText('Project')).toBeInTheDocument()
    expect(screen.getByText('Status')).toBeInTheDocument()
  })

  it('preserves direction when switching field', () => {
    const onChange = vi.fn()
    renderGroupByDropdown({ sort: { field: 'dueDate', direction: 'desc' }, onChange })
    fireEvent.click(screen.getByRole('button', { name: /group by/i }))
    fireEvent.click(screen.getByText('Created'))
    expect(onChange).toHaveBeenCalledWith({ field: 'createdAt', direction: 'desc' })
  })
})
