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

// The real Radix Popover does not open on click in jsdom. Stub the wrapper so the
// trigger click flips `onOpenChange(true)` and the content renders only when open.
vi.mock('@/components/ui/popover', async () => {
  const React = await import('react')
  return {
    Popover: ({ open, onOpenChange, children }: any) =>
      React.createElement(
        React.Fragment,
        null,
        React.Children.map(children, (child: any) =>
          React.isValidElement(child) ? React.cloneElement(child, { open, onOpenChange }) : child
        )
      ),
    PopoverTrigger: ({ children, onOpenChange }: any) =>
      React.cloneElement(children, {
        onClick: (e: any) => {
          children.props.onClick?.(e)
          onOpenChange?.(true)
        }
      }),
    PopoverContent: ({ children, open }: any) =>
      open ? React.createElement('div', null, children) : null
  }
})

describe('FolderEmojiChip', () => {
  it('renders folder icon button when no custom icon', () => {
    const onIconChange = vi.fn()
    render(<FolderEmojiChip icon={null} onIconChange={onIconChange} />)

    const btn = screen.getByRole('button')
    expect(btn).toBeDefined()
  })

  it('opens emoji picker when button clicked', async () => {
    const onIconChange = vi.fn()
    render(<FolderEmojiChip icon={null} onIconChange={onIconChange} />)

    const btn = screen.getByRole('button')
    fireEvent.click(btn)

    expect(await screen.findByTestId('emoji-picker')).toBeDefined()
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
