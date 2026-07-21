import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { IconPickerButton } from './icon-picker-button'

// Mock the lazy EmojiPicker with a minimal stub exposing Select/Remove/Close.
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

describe('IconPickerButton', () => {
  it('renders the trigger button with the given ariaLabel and glyph', () => {
    render(
      <IconPickerButton hasIcon={false} onIconChange={vi.fn()} ariaLabel="Set icon">
        <span>📝</span>
      </IconPickerButton>
    )

    const btn = screen.getByRole('button', { name: 'Set icon' })
    expect(btn).toBeDefined()
    expect(screen.getByText('📝')).toBeDefined()
  })

  it('renders the leading element before the trigger', () => {
    render(
      <IconPickerButton
        hasIcon={false}
        onIconChange={vi.fn()}
        ariaLabel="Set icon"
        leading={<span data-testid="chevron" />}
      >
        <span>📝</span>
      </IconPickerButton>
    )

    expect(screen.getByTestId('chevron')).toBeDefined()
  })

  it('opens the picker on trigger click when uncontrolled', async () => {
    render(
      <IconPickerButton hasIcon={false} onIconChange={vi.fn()} ariaLabel="Set icon">
        <span>📝</span>
      </IconPickerButton>
    )

    expect(screen.queryByTestId('emoji-picker')).toBeFalsy()
    fireEvent.click(screen.getByRole('button', { name: 'Set icon' }))
    expect(await screen.findByTestId('emoji-picker')).toBeDefined()
  })

  it('calls onIconChange with the picked value', () => {
    const onIconChange = vi.fn()
    render(
      <IconPickerButton hasIcon={false} onIconChange={onIconChange} ariaLabel="Set icon">
        <span>📝</span>
      </IconPickerButton>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Set icon' }))
    fireEvent.click(screen.getByText('Select 🎯'))

    expect(onIconChange).toHaveBeenCalledWith('🎯')
  })

  it('calls onIconChange with null when removed', () => {
    const onIconChange = vi.fn()
    render(
      <IconPickerButton hasIcon onIconChange={onIconChange} ariaLabel="Set icon">
        <span>⭐</span>
      </IconPickerButton>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Set icon' }))
    fireEvent.click(screen.getByText('Remove'))

    expect(onIconChange).toHaveBeenCalledWith(null)
  })

  it('honours the controlled pickerOpen prop', () => {
    const { rerender } = render(
      <IconPickerButton
        hasIcon={false}
        onIconChange={vi.fn()}
        ariaLabel="Set icon"
        pickerOpen={false}
        onPickerOpenChange={vi.fn()}
      >
        <span>📝</span>
      </IconPickerButton>
    )
    expect(screen.queryByTestId('emoji-picker')).toBeFalsy()

    rerender(
      <IconPickerButton
        hasIcon={false}
        onIconChange={vi.fn()}
        ariaLabel="Set icon"
        pickerOpen
        onPickerOpenChange={vi.fn()}
      >
        <span>📝</span>
      </IconPickerButton>
    )
    expect(screen.getByTestId('emoji-picker')).toBeDefined()
  })

  it('fires onPickerOpenChange(true) when the trigger is clicked (controlled)', () => {
    const onPickerOpenChange = vi.fn()
    render(
      <IconPickerButton
        hasIcon={false}
        onIconChange={vi.fn()}
        ariaLabel="Set icon"
        pickerOpen={false}
        onPickerOpenChange={onPickerOpenChange}
      >
        <span>📝</span>
      </IconPickerButton>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Set icon' }))
    expect(onPickerOpenChange).toHaveBeenCalledWith(true)
  })
})
