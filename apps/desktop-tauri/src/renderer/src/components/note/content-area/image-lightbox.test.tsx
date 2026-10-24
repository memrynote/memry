import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ImageLightbox } from './image-lightbox'

describe('ImageLightbox', () => {
  // jsdom has no pointer capture
  HTMLElement.prototype.setPointerCapture = vi.fn()

  it('zooms with the buttons and resets', async () => {
    render(<ImageLightbox src="a.png" alt="a" onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /zoom in/i }))
    expect(screen.getByText('125%')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /reset zoom/i }))
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('closes on Escape and on a click outside the image, not on the image', async () => {
    const onClose = vi.fn()
    render(<ImageLightbox src="a.png" alt="a" onClose={onClose} />)
    await userEvent.click(screen.getByRole('img'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('image-lightbox'))
    expect(onClose).toHaveBeenCalledTimes(1)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
