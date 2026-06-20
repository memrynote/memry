import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FolderEmojiChip } from './folder-emoji-chip'

// Mock the lazy EmojiPicker
vi.mock('@/components/note/note-title/EmojiPicker', () => ({
  EmojiPicker: ({ onSelect, onRemove, onClose, isOpen }: any) =>
    isOpen ? (
      <div data-testid="emoji-picker">
        <button onClick={() => onSelect('🎯')}>Select 🎯</button>
        <button onClick={onRemove}>Remove</button>
        <button onClick={onClose}>Close</button>
      </div>
    ) : null
}))

describe('FolderEmojiChip', () => {
  it('renders folder icon button when no custom icon', () => {
    const onIconChange = vi.fn()
    render(<FolderEmojiChip icon={null} onIconChange={onIconChange} />)

    const btn = screen.getByRole('button')
    expect(btn).toBeDefined()
  })

  it('opens emoji picker when button clicked', () => {
    const onIconChange = vi.fn()
    render(<FolderEmojiChip icon={null} onIconChange={onIconChange} />)

    const btn = screen.getByRole('button')
    fireEvent.click(btn)

    expect(screen.getByTestId('emoji-picker')).toBeDefined()
  })

  it('calls onIconChange when emoji selected', () => {
    const onIconChange = vi.fn()
    render(<FolderEmojiChip icon={null} onIconChange={onIconChange} />)

    const btn = screen.getByRole('button')
    fireEvent.click(btn)

    const selectBtn = screen.getByText('Select 🎯')
    fireEvent.click(selectBtn)

    expect(onIconChange).toHaveBeenCalledWith('🎯')
  })

  it('closes picker after selecting emoji', () => {
    const onIconChange = vi.fn()
    const { rerender } = render(<FolderEmojiChip icon={null} onIconChange={onIconChange} />)

    const btn = screen.getByRole('button')
    fireEvent.click(btn)

    const selectBtn = screen.getByText('Select 🎯')
    fireEvent.click(selectBtn)

    // Re-render to check if picker closed
    rerender(<FolderEmojiChip icon="🎯" onIconChange={onIconChange} />)

    expect(screen.queryByTestId('emoji-picker')).toBeFalsy()
  })

  it('calls onIconChange with null when remove clicked', () => {
    const onIconChange = vi.fn()
    render(<FolderEmojiChip icon="🎯" onIconChange={onIconChange} />)

    const btn = screen.getByRole('button')
    fireEvent.click(btn)

    const removeBtn = screen.getByText('Remove')
    fireEvent.click(removeBtn)

    expect(onIconChange).toHaveBeenCalledWith(null)
  })

  it('closes picker when onClose called', () => {
    const onIconChange = vi.fn()
    const { rerender } = render(<FolderEmojiChip icon={null} onIconChange={onIconChange} />)

    const btn = screen.getByRole('button')
    fireEvent.click(btn)

    const closeBtn = screen.getByText('Close')
    fireEvent.click(closeBtn)

    rerender(<FolderEmojiChip icon={null} onIconChange={onIconChange} />)

    expect(screen.queryByTestId('emoji-picker')).toBeFalsy()
  })
})
