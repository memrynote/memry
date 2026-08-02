import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BulkActionBar } from './bulk-action-bar'
import { tagsService } from '@/services/tags-service'

vi.mock('@/services/tags-service', () => ({
  tagsService: {
    pinNoteToTag: vi.fn()
  }
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))

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
    fireEvent.change(input, { target: { value: 'imp' } })

    const importantTag = screen.getByText('important')
    fireEvent.click(importantTag)

    expect(input.value).toBe('')
  })
})

describe('BulkActionBar tag scope', () => {
  const noteRow = { id: 'note-1', kind: 'note' as const }
  const taskRow = { id: 'task-1', kind: 'task' as const }

  const props = {
    availableTags: [],
    onMove: vi.fn(),
    onCopyLinks: vi.fn(),
    onAddTag: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
    onClear: vi.fn()
  }

  beforeEach(() => {
    vi.mocked(tagsService.pinNoteToTag).mockReset()
    vi.mocked(tagsService.pinNoteToTag).mockResolvedValue({ success: true })
  })

  it('pins only the selected note rows to the tag', async () => {
    render(
      <BulkActionBar
        {...props}
        count={2}
        scope={{ kind: 'tag', tag: 'araba' }}
        selectedRows={[noteRow, taskRow]}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: /pin/i }))

    expect(tagsService.pinNoteToTag).toHaveBeenCalledTimes(1)
    expect(tagsService.pinNoteToTag).toHaveBeenCalledWith({ noteId: 'note-1', tag: 'araba' })
  })

  it('hides the pin action under folder scope', () => {
    render(
      <BulkActionBar
        {...props}
        count={1}
        scope={{ kind: 'folder', path: 'projects' }}
        selectedRows={[noteRow]}
      />
    )

    expect(screen.queryByRole('button', { name: /pin/i })).not.toBeInTheDocument()
  })

  it('disables delete and move when a non-note row is selected', () => {
    render(
      <BulkActionBar
        {...props}
        count={2}
        scope={{ kind: 'tag', tag: 'araba' }}
        selectedRows={[noteRow, taskRow]}
      />
    )

    expect(screen.getByRole('button', { name: /delete/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /move/i })).toBeDisabled()
  })
})
