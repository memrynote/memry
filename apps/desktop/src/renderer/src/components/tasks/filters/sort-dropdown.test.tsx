import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { SortDropdown } from './sort-dropdown'
import type { TaskSort } from '@/data/tasks-data'
import { defaultSort } from '@/data/tasks-data'

const renderSortDropdown = (
  overrides: Partial<{ sort: TaskSort; onChange: (s: TaskSort) => void }> = {}
) => {
  const onChange = overrides.onChange ?? vi.fn()
  const sort = overrides.sort ?? defaultSort
  return { onChange, ...render(<SortDropdown sort={sort} onChange={onChange} />) }
}

describe('SortDropdown', () => {
  it('renders the sort trigger button', () => {
    renderSortDropdown()
    expect(screen.getByRole('button', { name: /sort/i })).toBeInTheDocument()
  })

  it('opens the dropdown popover on click', () => {
    renderSortDropdown()
    fireEvent.click(screen.getByRole('button', { name: /sort/i }))
    expect(screen.getByText('Due date')).toBeInTheDocument()
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('Created')).toBeInTheDocument()
    expect(screen.getByText('Title')).toBeInTheDocument()
    expect(screen.getByText('Project')).toBeInTheDocument()
  })

  it('shows the default sort field as selected', () => {
    renderSortDropdown({ sort: { field: 'dueDate', direction: 'asc' } })
    fireEvent.click(screen.getByRole('button', { name: /sort/i }))
    const dueDateButton = screen.getByText('Due date').closest('button')!
    expect(dueDateButton.className).toMatch(/bg-accent/)
  })

  it('calls onChange with the new field when a different sort is selected', () => {
    const onChange = vi.fn()
    renderSortDropdown({ sort: { field: 'dueDate', direction: 'asc' }, onChange })
    fireEvent.click(screen.getByRole('button', { name: /sort/i }))
    fireEvent.click(screen.getByText('Priority'))
    expect(onChange).toHaveBeenCalledWith({ field: 'priority', direction: 'asc' })
  })

  it('shows direction toggle arrows for the selected field', () => {
    renderSortDropdown({ sort: { field: 'priority', direction: 'asc' } })
    fireEvent.click(screen.getByRole('button', { name: /sort/i }))
    expect(screen.getByRole('button', { name: /ascending/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /descending/i })).toBeInTheDocument()
  })

  it('calls onChange with desc when descending arrow is clicked', () => {
    const onChange = vi.fn()
    renderSortDropdown({ sort: { field: 'dueDate', direction: 'asc' }, onChange })
    fireEvent.click(screen.getByRole('button', { name: /sort/i }))
    fireEvent.click(screen.getByRole('button', { name: /descending/i }))
    expect(onChange).toHaveBeenCalledWith({ field: 'dueDate', direction: 'desc' })
  })

  it('calls onChange with asc when ascending arrow is clicked', () => {
    const onChange = vi.fn()
    renderSortDropdown({ sort: { field: 'priority', direction: 'desc' }, onChange })
    fireEvent.click(screen.getByRole('button', { name: /sort/i }))
    fireEvent.click(screen.getByRole('button', { name: /ascending/i }))
    expect(onChange).toHaveBeenCalledWith({ field: 'priority', direction: 'asc' })
  })

  it('resets to default sort when clicking default field', () => {
    const onChange = vi.fn()
    renderSortDropdown({ sort: { field: 'title', direction: 'desc' }, onChange })
    fireEvent.click(screen.getByRole('button', { name: /sort/i }))
    fireEvent.click(screen.getByText('Priority'))
    expect(onChange).toHaveBeenCalledWith({ field: 'priority', direction: 'desc' })
  })

  it('shows direction arrows only once (for active sort)', () => {
    renderSortDropdown({ sort: { field: 'dueDate', direction: 'asc' } })
    fireEvent.click(screen.getByRole('button', { name: /sort/i }))
    const arrows = screen.getAllByRole('button', { name: /ascending|descending/i })
    expect(arrows).toHaveLength(2)
  })

  it('shows all five sort options as buttons', () => {
    renderSortDropdown()
    fireEvent.click(screen.getByRole('button', { name: /sort/i }))
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('Due date')).toBeInTheDocument()
    expect(screen.getByText('Created')).toBeInTheDocument()
    expect(screen.getByText('Title')).toBeInTheDocument()
    expect(screen.getByText('Project')).toBeInTheDocument()
  })

  it('preserves direction when switching sort field', () => {
    const onChange = vi.fn()
    renderSortDropdown({ sort: { field: 'dueDate', direction: 'desc' }, onChange })
    fireEvent.click(screen.getByRole('button', { name: /sort/i }))
    fireEvent.click(screen.getByText('Created'))
    expect(onChange).toHaveBeenCalledWith({ field: 'createdAt', direction: 'desc' })
  })
})
