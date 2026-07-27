import type { ReactNode } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { CategoryBlock, type CategoryBlockProps } from './category-block'

const tags = [
  { tag: 'meetings', color: 'blue', icon: null, count: 12, sortOrder: 0 },
  { tag: 'work/1:1', color: 'red', icon: null, count: 8, sortOrder: 1 }
]

// CategoryBlock is a dnd-kit sortable/droppable (block-level reorder + a
// nested tag SortableContext), so every render needs a `DndContext`
// ancestor — same requirement as `sortable-project-item.test.tsx`. The
// PointerSensor needs the same `distance` activation constraint the real
// page configures: without it, dnd-kit treats every pointerdown as an
// immediate drag start and swallows the click that follows (a plain
// `<DndContext>` with no sensors reproduces this).
const TestDndContext = ({ children }: { children: ReactNode }) => {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  return <DndContext sensors={sensors}>{children}</DndContext>
}

const renderBlock = (props: CategoryBlockProps): ReturnType<typeof render> =>
  render(
    <TestDndContext>
      <CategoryBlock {...props} />
    </TestDndContext>
  )

describe('CategoryBlock', () => {
  it('shows the category name and its tag count', () => {
    renderBlock({ id: 'cat-1', name: 'Work', tags, onTagOpen: vi.fn() })
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('renders one chip per tag with its full name and item count', () => {
    renderBlock({ id: 'cat-1', name: 'Work', tags, onTagOpen: vi.fn() })
    expect(screen.getByText('work/1:1')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
  })

  it('calls onTagOpen with the tag name when a chip is clicked', async () => {
    const onTagOpen = vi.fn()
    renderBlock({ id: 'cat-1', name: 'Work', tags, onTagOpen })

    await userEvent.click(screen.getByRole('button', { name: /meetings/ }))

    expect(onTagOpen).toHaveBeenCalledWith('meetings')
  })

  it('offers no rename or delete on the uncategorized block', () => {
    renderBlock({ id: null, name: 'Uncategorized', tags, onTagOpen: vi.fn() })
    expect(screen.queryByRole('button', { name: /category options/i })).not.toBeInTheDocument()
  })

  it('shows an empty hint when a category has no tags', () => {
    renderBlock({ id: 'cat-1', name: 'Blog', tags: [], onTagOpen: vi.fn() })
    expect(screen.getByText(/drag a tag here/i)).toBeInTheDocument()
  })

  it('renames inline on Enter', async () => {
    const onRename = vi.fn()
    renderBlock({ id: 'cat-1', name: 'Work', tags, onTagOpen: vi.fn(), onRename })

    await userEvent.click(screen.getByRole('button', { name: /category options/i }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /rename category/i }))
    const input = screen.getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, 'Job{Enter}')

    expect(onRename).toHaveBeenCalledWith('Job')
  })

  it('warns that tags survive before deleting', async () => {
    const onDelete = vi.fn()
    renderBlock({ id: 'cat-1', name: 'Work', tags, onTagOpen: vi.fn(), onDelete })

    await userEvent.click(screen.getByRole('button', { name: /category options/i }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /delete category/i }))

    expect(await screen.findByText(/tags will move to uncategorized/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    expect(onDelete).toHaveBeenCalled()
  })

  it('exposes a drag handle on a real category', () => {
    renderBlock({ id: 'cat-1', name: 'Work', tags, onTagOpen: vi.fn() })
    expect(screen.getByRole('button', { name: /drag to reorder/i })).toBeInTheDocument()
  })

  it('offers no drag handle on the uncategorized block', () => {
    renderBlock({ id: null, name: 'Uncategorized', tags, onTagOpen: vi.fn() })
    expect(screen.queryByRole('button', { name: /drag to reorder/i })).not.toBeInTheDocument()
  })
})
