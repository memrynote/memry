import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CategoryBlock } from './category-block'

const tags = [
  { tag: 'meetings', color: 'blue', icon: null, count: 12, sortOrder: 0 },
  { tag: 'work/1:1', color: 'red', icon: null, count: 8, sortOrder: 1 }
]

describe('CategoryBlock', () => {
  it('shows the category name and its tag count', () => {
    render(<CategoryBlock id="cat-1" name="Work" tags={tags} onTagOpen={vi.fn()} />)
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('renders one chip per tag with its full name and item count', () => {
    render(<CategoryBlock id="cat-1" name="Work" tags={tags} onTagOpen={vi.fn()} />)
    expect(screen.getByText('work/1:1')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
  })

  it('calls onTagOpen with the tag name when a chip is clicked', async () => {
    const onTagOpen = vi.fn()
    render(<CategoryBlock id="cat-1" name="Work" tags={tags} onTagOpen={onTagOpen} />)

    await userEvent.click(screen.getByRole('button', { name: /meetings/ }))

    expect(onTagOpen).toHaveBeenCalledWith('meetings')
  })

  it('offers no rename or delete on the uncategorized block', () => {
    render(<CategoryBlock id={null} name="Uncategorized" tags={tags} onTagOpen={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument()
  })

  it('shows an empty hint when a category has no tags', () => {
    render(<CategoryBlock id="cat-1" name="Blog" tags={[]} onTagOpen={vi.fn()} />)
    expect(screen.getByText(/drag a tag here/i)).toBeInTheDocument()
  })

  it('renames inline on Enter', async () => {
    const onRename = vi.fn()
    render(
      <CategoryBlock id="cat-1" name="Work" tags={tags} onTagOpen={vi.fn()} onRename={onRename} />
    )

    await userEvent.click(screen.getByRole('button', { name: /rename/i }))
    const input = screen.getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, 'Job{Enter}')

    expect(onRename).toHaveBeenCalledWith('Job')
  })

  it('warns that tags survive before deleting', async () => {
    const onDelete = vi.fn()
    render(
      <CategoryBlock id="cat-1" name="Work" tags={tags} onTagOpen={vi.fn()} onDelete={onDelete} />
    )

    await userEvent.click(screen.getByRole('button', { name: /delete/i }))

    expect(screen.getByText(/tags will move to uncategorized/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    expect(onDelete).toHaveBeenCalled()
  })
})
