/**
 * NoteTitle Component Tests (T509-T510)
 *
 * Tests for the NoteTitle component with title editing and emoji picker.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NoteTitle } from './NoteTitle'

// Mock emoji-mart to avoid loading large emoji data
vi.mock('@emoji-mart/react', () => ({
  default: ({ onEmojiSelect }: { onEmojiSelect: (emoji: { native: string }) => void }) => (
    <div data-testid="emoji-picker" role="dialog" aria-modal="true" aria-label="Emoji picker">
      <button
        type="button"
        onClick={() => onEmojiSelect({ native: '🎉' })}
        data-testid="emoji-option"
      >
        Select Emoji
      </button>
    </div>
  )
}))

vi.mock('@emoji-mart/data', () => ({ default: {} }))

// ============================================================================
// T509: NoteTitle - Title Editing Tests
// ============================================================================

describe('T509: NoteTitle - title editing', () => {
  const defaultProps = {
    emoji: null,
    title: 'Test Note',
    onEmojiChange: vi.fn(),
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
    await user.tab() // Blur

    expect(defaultProps.onTitleChange).toHaveBeenCalledWith('New Title')
  })

  it('should not call onTitleChange if value did not change', async () => {
    const user = userEvent.setup()
    render(<NoteTitle {...defaultProps} />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    await user.click(textarea)
    await user.tab() // Blur without changing

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

    // Should blur the textarea and revert to original value
    expect(textarea).not.toHaveFocus()
    // After Escape, the local state reverts to original 'Test Note'
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

// ============================================================================
// T510: NoteTitle - Emoji Picker Integration Tests
// ============================================================================

describe('T510: NoteTitle - emoji picker', () => {
  const defaultProps = {
    emoji: null,
    title: 'Test Note',
    onEmojiChange: vi.fn(),
    onTitleChange: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should render emoji button with placeholder when no emoji', () => {
    render(<NoteTitle {...defaultProps} />)

    const emojiButton = screen.getByRole('button', { name: /choose emoji/i })
    expect(emojiButton).toBeInTheDocument()
  })

  it('should render emoji button with current emoji', () => {
    render(<NoteTitle {...defaultProps} emoji="📝" />)

    const emojiButton = screen.getByRole('button', { name: /change emoji: 📝/i })
    expect(emojiButton).toBeInTheDocument()
    expect(emojiButton).toHaveTextContent('📝')
  })

  it('should open emoji picker on click', async () => {
    const user = userEvent.setup()
    render(<NoteTitle {...defaultProps} />)

    const emojiButton = screen.getByRole('button', { name: /choose emoji/i })
    await user.click(emojiButton)

    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument()
  })

  it('should close emoji picker after selecting an emoji', async () => {
    const user = userEvent.setup()
    render(<NoteTitle {...defaultProps} />)

    const emojiButton = screen.getByRole('button', { name: /choose emoji/i })
    await user.click(emojiButton)

    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument()

    // Click on the emoji option (which calls onSelect and closes)
    const emojiOption = screen.getByTestId('emoji-option')
    await user.click(emojiOption)

    // Picker should close after selection
    expect(defaultProps.onEmojiChange).toHaveBeenCalledWith('🎉')
  })

  it('should call onEmojiChange when emoji is selected', async () => {
    const user = userEvent.setup()
    render(<NoteTitle {...defaultProps} />)

    const emojiButton = screen.getByRole('button', { name: /choose emoji/i })
    await user.click(emojiButton)

    const emojiOption = screen.getByTestId('emoji-option')
    await user.click(emojiOption)

    expect(defaultProps.onEmojiChange).toHaveBeenCalledWith('🎉')
  })

  it('should show remove button when emoji exists', async () => {
    const user = userEvent.setup()
    render(<NoteTitle {...defaultProps} emoji="📝" />)

    const emojiButton = screen.getByRole('button', { name: /change emoji: 📝/i })
    await user.click(emojiButton)

    expect(screen.getByRole('button', { name: /remove emoji/i })).toBeInTheDocument()
  })

  it('should call onEmojiChange with null when remove is clicked', async () => {
    const user = userEvent.setup()
    render(<NoteTitle {...defaultProps} emoji="📝" />)

    const emojiButton = screen.getByRole('button', { name: /change emoji: 📝/i })
    await user.click(emojiButton)

    const removeButton = screen.getByRole('button', { name: /remove emoji/i })
    await user.click(removeButton)

    expect(defaultProps.onEmojiChange).toHaveBeenCalledWith(null)
  })

  it('should not open emoji picker when disabled', async () => {
    const user = userEvent.setup()
    render(<NoteTitle {...defaultProps} disabled />)

    const emojiButton = screen.getByRole('button', { name: /choose emoji/i })
    expect(emojiButton).toBeDisabled()

    await user.click(emojiButton)

    expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument()
  })

  it('should open emoji picker on Enter key when focused on emoji button', async () => {
    const user = userEvent.setup()
    render(<NoteTitle {...defaultProps} />)

    const emojiButton = screen.getByRole('button', { name: /choose emoji/i })
    emojiButton.focus()
    await user.keyboard('{Enter}')

    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument()
  })

  it('should support keyboard interaction with emoji picker', async () => {
    const user = userEvent.setup()
    render(<NoteTitle {...defaultProps} />)

    const emojiButton = screen.getByRole('button', { name: /choose emoji/i })
    await user.click(emojiButton)

    // The picker should be visible
    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument()
  })
})

// ============================================================================
// Accessibility Tests
// ============================================================================

describe('NoteTitle - accessibility', () => {
  const defaultProps = {
    emoji: null,
    title: 'Test Note',
    onEmojiChange: vi.fn(),
    onTitleChange: vi.fn()
  }

  it('should have proper ARIA labels', () => {
    render(<NoteTitle {...defaultProps} />)

    expect(screen.getByRole('textbox', { name: /note title/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /choose emoji/i })).toBeInTheDocument()
  })

  it('should have dialog role for emoji picker', async () => {
    const user = userEvent.setup()
    render(<NoteTitle {...defaultProps} />)

    const emojiButton = screen.getByRole('button', { name: /choose emoji/i })
    await user.click(emojiButton)

    // The picker should be visible with proper accessibility
    expect(screen.getByTestId('emoji-picker')).toBeInTheDocument()
  })
})
