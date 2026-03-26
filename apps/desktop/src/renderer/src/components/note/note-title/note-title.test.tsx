import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NoteTitle } from './NoteTitle'

describe('NoteTitle - title editing', () => {
  const defaultProps = {
    emoji: null,
    title: 'Test Note',
    onTitleChange: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should render with title', () => {
    render(<NoteTitle {...defaultProps} />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    expect(textarea).toHaveValue('Test Note')
  })

  it('should render with placeholder when title is empty', () => {
    render(<NoteTitle {...defaultProps} title="" placeholder="Untitled" />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    expect(textarea).toHaveAttribute('placeholder', 'Untitled')
  })

  it('should use custom placeholder', () => {
    render(<NoteTitle {...defaultProps} title="" placeholder="Enter a title..." />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    expect(textarea).toHaveAttribute('placeholder', 'Enter a title...')
  })

  it('should call onTitleChange on blur when value changes', async () => {
    const user = userEvent.setup()
    render(<NoteTitle {...defaultProps} />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    await user.clear(textarea)
    await user.type(textarea, 'New Title')
    await user.tab()

    expect(defaultProps.onTitleChange).toHaveBeenCalledWith('New Title')
  })

  it('should not call onTitleChange if value did not change', async () => {
    const user = userEvent.setup()
    render(<NoteTitle {...defaultProps} />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    await user.click(textarea)
    await user.tab()

    expect(defaultProps.onTitleChange).not.toHaveBeenCalled()
  })

  it('should save on Enter key press', async () => {
    const user = userEvent.setup()
    render(<NoteTitle {...defaultProps} />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    await user.clear(textarea)
    await user.type(textarea, 'Enter Title{enter}')

    expect(defaultProps.onTitleChange).toHaveBeenCalledWith('Enter Title')
  })

  it('should revert and blur on Escape key press', async () => {
    const user = userEvent.setup()
    render(<NoteTitle {...defaultProps} />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    await user.clear(textarea)
    await user.type(textarea, 'Changed Title')
    await user.keyboard('{Escape}')

    expect(textarea).not.toHaveFocus()
    expect(textarea).toHaveValue('Test Note')
  })

  it('should be disabled when disabled prop is true', () => {
    render(<NoteTitle {...defaultProps} disabled />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    expect(textarea).toBeDisabled()
  })

  it('should auto-focus when autoFocus is true', () => {
    render(<NoteTitle {...defaultProps} autoFocus />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    expect(textarea).toHaveFocus()
  })
})

describe('NoteTitle - emoji display', () => {
  it('should display emoji when set', () => {
    render(<NoteTitle emoji="📝" title="Test" onTitleChange={vi.fn()} />)

    expect(screen.getByText('📝')).toBeInTheDocument()
  })

  it('should not render emoji container when emoji is null', () => {
    const { container } = render(<NoteTitle emoji={null} title="Test" onTitleChange={vi.fn()} />)

    expect(container.querySelector('.bg-sidebar-terracotta\\/8')).not.toBeInTheDocument()
  })
})

describe('NoteTitle - accessibility', () => {
  it('should have proper ARIA label on title input', () => {
    render(<NoteTitle emoji={null} title="Test Note" onTitleChange={vi.fn()} />)

    expect(screen.getByRole('textbox', { name: /note title/i })).toBeInTheDocument()
  })
})
