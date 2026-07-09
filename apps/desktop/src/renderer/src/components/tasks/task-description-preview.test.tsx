import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TaskDescriptionPreview } from './task-description-preview'

describe('TaskDescriptionPreview', () => {
  it('renders plain text as-is', () => {
    render(<TaskDescriptionPreview markdown="Just some plain text" />)
    expect(screen.getByText('Just some plain text')).toBeInTheDocument()
  })

  it('renders bold markdown as a <strong> element, not raw asterisks', () => {
    const { container } = render(<TaskDescriptionPreview markdown="an **important** note" />)
    const strong = container.querySelector('strong')
    expect(strong).not.toBeNull()
    expect(strong?.textContent).toBe('important')
    expect(container.textContent).not.toContain('**')
  })

  it('renders a markdown link as a clickable anchor and opens it externally', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<TaskDescriptionPreview markdown="see [the docs](https://memry.app)" />)

    const link = screen.getByRole('link', { name: 'the docs' })
    expect(link).toHaveAttribute('href', 'https://memry.app')

    await userEvent.click(link)
    expect(openSpy).toHaveBeenCalledWith('https://memry.app', '_blank', 'noopener,noreferrer')
    openSpy.mockRestore()
  })

  it('flattens list markers into bulleted text lines', () => {
    const { container } = render(<TaskDescriptionPreview markdown={'- first\n- second'} />)
    expect(container.textContent).toContain('first')
    expect(container.textContent).toContain('second')
    expect(container.textContent).toContain('•')
  })

  it('applies the passed className and testid', () => {
    render(
      <TaskDescriptionPreview markdown="text" className="line-clamp-3" data-testid="description" />
    )
    expect(screen.getByTestId('description')).toHaveClass('line-clamp-3')
  })
})
