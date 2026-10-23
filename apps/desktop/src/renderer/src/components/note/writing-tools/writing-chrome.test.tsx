import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { WritingChrome } from './writing-chrome'

function renderChrome(overrides: Partial<Parameters<typeof WritingChrome>[0]> = {}) {
  const props = {
    mode: null,
    onSelectMode: vi.fn(),
    alternativeCount: 2,
    overflowCount: 0,
    ...overrides
  }
  render(<WritingChrome {...props} />)
  return props
}

describe('WritingChrome', () => {
  it('shows a single control at rest', () => {
    renderChrome()
    expect(screen.getByRole('button', { name: 'Writing tools' })).toBeInTheDocument()
  })

  it('opens a rail mode from the menu', async () => {
    const props = renderChrome()
    await userEvent.click(screen.getByRole('button', { name: 'Writing tools' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Overflow/ }))
    expect(props.onSelectMode).toHaveBeenCalledWith('overflow')
  })

  it('closes the rail when the open mode is picked again', async () => {
    const props = renderChrome({ mode: 'alternatives' })
    await userEvent.click(screen.getByRole('button', { name: 'Writing tools' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Alternatives/ }))
    expect(props.onSelectMode).toHaveBeenCalledWith(null)
  })
})
