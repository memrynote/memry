import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { WritingChrome } from './writing-chrome'

function renderChrome(overrides: Partial<Parameters<typeof WritingChrome>[0]> = {}) {
  const props = {
    mode: null,
    onSelectMode: vi.fn(),
    aiEnabled: true,
    alternativeCount: 2,
    overflowCount: 0,
    wordCountVisible: false,
    wordCount: 412,
    onToggleWordCount: vi.fn(),
    ...overrides
  }
  render(<WritingChrome {...props} />)
  return props
}

describe('WritingChrome', () => {
  it('shows a single control at rest and no word count', () => {
    renderChrome()
    expect(screen.getByRole('button', { name: 'Writing tools' })).toBeInTheDocument()
    expect(screen.queryByTestId('note-word-count')).toBeNull()
  })

  it('shows the live count as text when turned on', () => {
    renderChrome({ wordCountVisible: true })
    expect(screen.getByTestId('note-word-count')).toHaveTextContent('412 words')
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

  it('leaves Lab out without AI', async () => {
    renderChrome({ aiEnabled: false })
    await userEvent.click(screen.getByRole('button', { name: 'Writing tools' }))
    expect(screen.queryByRole('menuitemradio', { name: /Lab/ })).toBeNull()
  })

  it('toggles the word count from the menu', async () => {
    const props = renderChrome()
    await userEvent.click(screen.getByRole('button', { name: 'Writing tools' }))
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Show word count' }))
    expect(props.onToggleWordCount).toHaveBeenCalledOnce()
  })
})
