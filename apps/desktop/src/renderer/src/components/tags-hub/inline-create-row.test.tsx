import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InlineCreateRow } from './inline-create-row'

describe('InlineCreateRow', () => {
  it('opens an inline input rather than a dialog', async () => {
    render(<InlineCreateRow onCreateCategory={vi.fn()} onCreateTag={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /new category/i }))

    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('creates a category on Enter', async () => {
    const onCreateCategory = vi.fn().mockResolvedValue(undefined)
    render(<InlineCreateRow onCreateCategory={onCreateCategory} onCreateTag={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /new category/i }))
    await userEvent.type(screen.getByRole('textbox'), 'Blog{Enter}')

    expect(onCreateCategory).toHaveBeenCalledWith('Blog')
  })

  it('cancels on Escape without creating', async () => {
    const onCreateCategory = vi.fn()
    render(<InlineCreateRow onCreateCategory={onCreateCategory} onCreateTag={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /new category/i }))
    await userEvent.type(screen.getByRole('textbox'), 'Blog{Escape}')

    expect(onCreateCategory).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('ignores a blank name', async () => {
    const onCreateCategory = vi.fn()
    render(<InlineCreateRow onCreateCategory={onCreateCategory} onCreateTag={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /new category/i }))
    await userEvent.type(screen.getByRole('textbox'), '   {Enter}')

    expect(onCreateCategory).not.toHaveBeenCalled()
  })

  it('offers a color palette when creating a tag', async () => {
    render(<InlineCreateRow onCreateCategory={vi.fn()} onCreateTag={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /new tag/i }))

    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /color/i }).length).toBeGreaterThan(0)
  })

  it('passes the owning category id when creating a tag', async () => {
    const onCreateTag = vi.fn().mockResolvedValue(undefined)
    render(
      <InlineCreateRow onCreateCategory={vi.fn()} onCreateTag={onCreateTag} categoryId="cat-1" />
    )

    await userEvent.click(screen.getByRole('button', { name: /new tag/i }))
    await userEvent.type(screen.getByRole('textbox'), 'draft{Enter}')

    expect(onCreateTag).toHaveBeenCalledWith('draft', expect.any(String), 'cat-1')
  })
})
