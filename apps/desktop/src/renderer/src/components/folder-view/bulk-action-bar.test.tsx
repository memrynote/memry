import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BulkActionBar } from './bulk-action-bar'

describe('BulkActionBar', () => {
  it('renders selection count', () => {
    const handlers = {
      onMove: vi.fn(),
      onCopyLinks: vi.fn(),
      onAddTag: vi.fn(),
      onExport: vi.fn(),
      onDelete: vi.fn(),
      onClear: vi.fn()
    }

    render(<BulkActionBar count={3} availableTags={[]} {...handlers} />)

    expect(screen.getByText('3')).toBeDefined()
  })

  it('calls onMove when move button clicked', () => {
    const onMove = vi.fn()
    const handlers = {
      onMove,
      onCopyLinks: vi.fn(),
      onAddTag: vi.fn(),
      onExport: vi.fn(),
      onDelete: vi.fn(),
      onClear: vi.fn()
    }

    render(<BulkActionBar count={1} availableTags={[]} {...handlers} />)

    const moveBtn = screen.getByText(/move/i)
    fireEvent.click(moveBtn)

    expect(onMove).toHaveBeenCalled()
  })

  it('calls onExport when export button clicked', () => {
    const onExport = vi.fn()
    const handlers = {
      onMove: vi.fn(),
      onCopyLinks: vi.fn(),
      onAddTag: vi.fn(),
      onExport,
      onDelete: vi.fn(),
      onClear: vi.fn()
    }

    render(<BulkActionBar count={1} availableTags={[]} {...handlers} />)

    const exportBtn = screen.getByText(/export/i)
    fireEvent.click(exportBtn)

    expect(onExport).toHaveBeenCalled()
  })

  it('calls onDelete when delete button clicked', () => {
    const onDelete = vi.fn()
    const handlers = {
      onMove: vi.fn(),
      onCopyLinks: vi.fn(),
      onAddTag: vi.fn(),
      onExport: vi.fn(),
      onDelete,
      onClear: vi.fn()
    }

    render(<BulkActionBar count={1} availableTags={[]} {...handlers} />)

    const deleteBtn = screen.getByText(/delete/i)
    fireEvent.click(deleteBtn)

    expect(onDelete).toHaveBeenCalled()
  })

  it('calls onClear when clear button clicked', () => {
    const onClear = vi.fn()
    const handlers = {
      onMove: vi.fn(),
      onCopyLinks: vi.fn(),
      onAddTag: vi.fn(),
      onExport: vi.fn(),
      onDelete: vi.fn(),
      onClear
    }

    render(<BulkActionBar count={1} availableTags={[]} {...handlers} />)

    const clearBtn = screen.getByLabelText(/clear/i)
    fireEvent.click(clearBtn)

    expect(onClear).toHaveBeenCalled()
  })

  it('filters tag suggestions by input', () => {
    const handlers = {
      onMove: vi.fn(),
      onCopyLinks: vi.fn(),
      onAddTag: vi.fn(),
      onExport: vi.fn(),
      onDelete: vi.fn(),
      onClear: vi.fn()
    }

    render(
      <BulkActionBar count={1} availableTags={['important', 'later', 'inbox']} {...handlers} />
    )

    const tagBtn = screen.getByText(/add tag/i)
    fireEvent.click(tagBtn)

    const input = screen.getByPlaceholderText(/tag name/i)
    fireEvent.change(input, { target: { value: 'imp' } })

    expect(screen.getByText('important')).toBeDefined()
    expect(screen.queryByText('later')).toBeFalsy()
  })

  it('calls onAddTag when tag suggestion clicked', () => {
    const onAddTag = vi.fn()
    const handlers = {
      onMove: vi.fn(),
      onCopyLinks: vi.fn(),
      onAddTag,
      onExport: vi.fn(),
      onDelete: vi.fn(),
      onClear: vi.fn()
    }

    render(<BulkActionBar count={1} availableTags={['important', 'later']} {...handlers} />)

    const tagBtn = screen.getByText(/add tag/i)
    fireEvent.click(tagBtn)

    const importantTag = screen.getByText('important')
    fireEvent.click(importantTag)

    expect(onAddTag).toHaveBeenCalledWith('important')
  })

  it('clears tag input after applying tag', () => {
    const onAddTag = vi.fn()
    const handlers = {
      onMove: vi.fn(),
      onCopyLinks: vi.fn(),
      onAddTag,
      onExport: vi.fn(),
      onDelete: vi.fn(),
      onClear: vi.fn()
    }

    render(<BulkActionBar count={1} availableTags={['important']} {...handlers} />)

    const tagBtn = screen.getByText(/add tag/i)
    fireEvent.click(tagBtn)

    const input = screen.getByPlaceholderText(/tag name/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'test' } })

    const importantTag = screen.getByText('important')
    fireEvent.click(importantTag)

    expect(input.value).toBe('')
  })
})
