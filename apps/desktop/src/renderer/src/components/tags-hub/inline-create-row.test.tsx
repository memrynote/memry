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

  it('cancels from the trailing clear button without creating', async () => {
    const onCreateCategory = vi.fn()
    render(<InlineCreateRow onCreateCategory={onCreateCategory} onCreateTag={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /new category/i }))
    await userEvent.type(screen.getByRole('textbox'), 'Blog')
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))

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

  it('keeps the color palette out of the row until it is asked for', async () => {
    render(<InlineCreateRow onCreateCategory={vi.fn()} onCreateTag={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /new tag/i }))

    expect(screen.getByRole('textbox')).toBeInTheDocument()
    // Only the swatch that opens the palette — not the palette itself, which
    // used to stack ~20 swatches under the input and push the rows below it.
    expect(screen.getAllByRole('button', { name: /color/i })).toHaveLength(1)
  })

  it('opens the full palette from the swatch', async () => {
    render(<InlineCreateRow onCreateCategory={vi.fn()} onCreateTag={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /new tag/i }))
    await userEvent.click(screen.getByRole('button', { name: /choose color/i }))

    expect(screen.getAllByRole('button', { name: /color/i }).length).toBeGreaterThan(1)
  })

  it('creates a tag with a color without the user picking one', async () => {
    const onCreateTag = vi.fn().mockResolvedValue(undefined)
    render(<InlineCreateRow onCreateCategory={vi.fn()} onCreateTag={onCreateTag} />)

    await userEvent.click(screen.getByRole('button', { name: /new tag/i }))
    await userEvent.type(screen.getByRole('textbox'), 'draft{Enter}')

    expect(onCreateTag).toHaveBeenCalledWith('draft', expect.stringMatching(/\S/), null)
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
