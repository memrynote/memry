import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { SavedFiltersSection } from './saved-filters-section'
import type { SavedFilter } from '@/data/tasks-data'
import { defaultFilters } from '@/data/tasks-data'

const makeSavedFilter = (overrides: Partial<SavedFilter> = {}): SavedFilter => ({
  id: 'sf-1',
  name: 'My filter',
  filters: defaultFilters,
  starred: false,
  createdAt: new Date(),
  ...overrides
})

const defaultProps = {
  savedFilters: [] as SavedFilter[],
  activeSavedFilterId: null,
  hasActiveFilters: true,
  onApply: vi.fn(),
  onDelete: vi.fn(),
  onToggleStar: vi.fn(),
  onSave: vi.fn()
}

describe('SavedFiltersSection', () => {
  describe('save input', () => {
    it('renders input and save button', () => {
      render(<SavedFiltersSection {...defaultProps} />)
      expect(screen.getByLabelText('Filter name')).toBeInTheDocument()
      expect(screen.getByLabelText('Save filter')).toBeInTheDocument()
    })

    it('disables input when no active filters', () => {
      render(<SavedFiltersSection {...defaultProps} hasActiveFilters={false} />)
      expect(screen.getByLabelText('Filter name')).toBeDisabled()
    })

    it('calls onSave with name when save is clicked', () => {
      const onSave = vi.fn()
      render(<SavedFiltersSection {...defaultProps} onSave={onSave} />)
      const input = screen.getByLabelText('Filter name')
      fireEvent.change(input, { target: { value: 'Sprint tasks' } })
      fireEvent.click(screen.getByLabelText('Save filter'))
      expect(onSave).toHaveBeenCalledWith('Sprint tasks')
    })

    it('calls onSave on Enter key', () => {
      const onSave = vi.fn()
      render(<SavedFiltersSection {...defaultProps} onSave={onSave} />)
      const input = screen.getByLabelText('Filter name')
      fireEvent.change(input, { target: { value: 'Quick' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onSave).toHaveBeenCalledWith('Quick')
    })

    it('clears input after save', () => {
      render(<SavedFiltersSection {...defaultProps} />)
      const input = screen.getByLabelText('Filter name') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'Test' } })
      fireEvent.click(screen.getByLabelText('Save filter'))
      expect(input.value).toBe('')
    })

    it('does not save empty name', () => {
      const onSave = vi.fn()
      render(<SavedFiltersSection {...defaultProps} onSave={onSave} />)
      fireEvent.click(screen.getByLabelText('Save filter'))
      expect(onSave).not.toHaveBeenCalled()
    })
  })

  describe('saved filters list', () => {
    it('renders saved filters', () => {
      const filters = [
        makeSavedFilter({ id: 'sf-1', name: 'Daily review' }),
        makeSavedFilter({ id: 'sf-2', name: 'Sprint bugs' })
      ]
      render(<SavedFiltersSection {...defaultProps} savedFilters={filters} />)
      expect(screen.getByText('Daily review')).toBeInTheDocument()
      expect(screen.getByText('Sprint bugs')).toBeInTheDocument()
    })

    it('calls onApply when a saved filter is clicked', () => {
      const onApply = vi.fn()
      const filter = makeSavedFilter({ id: 'sf-1', name: 'My filter' })
      render(<SavedFiltersSection {...defaultProps} savedFilters={[filter]} onApply={onApply} />)
      fireEvent.click(screen.getByText('My filter'))
      expect(onApply).toHaveBeenCalledWith(filter)
    })

    it('calls onDelete when trash icon is clicked', () => {
      const onDelete = vi.fn()
      const filter = makeSavedFilter({ id: 'sf-1', name: 'Old filter' })
      render(<SavedFiltersSection {...defaultProps} savedFilters={[filter]} onDelete={onDelete} />)
      fireEvent.click(screen.getByLabelText('Delete Old filter'))
      expect(onDelete).toHaveBeenCalledWith('sf-1')
    })
  })

  describe('star toggle', () => {
    it('calls onToggleStar when star icon is clicked', () => {
      const onToggleStar = vi.fn()
      const filter = makeSavedFilter({ id: 'sf-1', name: 'Starred test' })
      render(
        <SavedFiltersSection
          {...defaultProps}
          savedFilters={[filter]}
          onToggleStar={onToggleStar}
        />
      )
      fireEvent.click(screen.getByLabelText('Star Starred test'))
      expect(onToggleStar).toHaveBeenCalledWith('sf-1')
    })

    it('shows Unstar label for starred filters', () => {
      const filter = makeSavedFilter({ id: 'sf-1', name: 'Pinned', starred: true })
      render(<SavedFiltersSection {...defaultProps} savedFilters={[filter]} />)
      expect(screen.getByLabelText('Unstar Pinned')).toBeInTheDocument()
    })

    it('shows Star label for unstarred filters', () => {
      const filter = makeSavedFilter({ id: 'sf-1', name: 'Normal', starred: false })
      render(<SavedFiltersSection {...defaultProps} savedFilters={[filter]} />)
      expect(screen.getByLabelText('Star Normal')).toBeInTheDocument()
    })
  })
})
