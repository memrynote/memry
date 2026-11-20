import { useRef, useState, type ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HintModeProvider } from '@/contexts/hint-mode'
import { useHintActivation } from '@/hooks/use-hint-activation'
import { findNoteTrigger, useTitleNotePicker } from './title-note-picker'

const { notes } = vi.hoisted(() => ({
  notes: [
    { id: 'note-1', title: 'Roadmap' },
    { id: 'note-2', title: 'Road trip' }
  ]
}))
vi.mock('@/components/capture-bar/capture-bar-suggestions', () => ({
  useNoteSuggestions: () => notes
}))

describe('findNoteTrigger', () => {
  it('opens on an unclosed `[[` before the caret', () => {
    expect(findNoteTrigger('Call [[Ann', [])).toEqual({ start: 5, query: 'Ann' })
    expect(findNoteTrigger('Call [[Anna]] ', [])).toBeNull()
  })

  it('opens on an `@` that does not read as a date', () => {
    expect(findNoteTrigger('Check up on @Person_D', [])).toEqual({ start: 12, query: 'Person_D' })
    expect(findNoteTrigger('Pack bags @home', [])).toEqual({ start: 10, query: 'home' })
  })

  it('ends an `@` query at a space unless a note title starts with it', () => {
    expect(findNoteTrigger('Check up on @Note A', ['Note Alpha'])).toEqual({
      start: 12,
      query: 'Note A'
    })
    expect(findNoteTrigger('Pack bags @home tonight', ['Home office'])).toBeNull()
  })

  it('leaves a date to the quick-add grammar', () => {
    expect(findNoteTrigger('Pay rent @tomorrow', [])).toBeNull()
    expect(findNoteTrigger('Pay rent @next fri', [])).toBeNull()
    // A note whose title reads like the date does not take the date over.
    expect(findNoteTrigger('Pay @friday 3pm', ['Friday 3pm sync'])).toBeNull()
    expect(findNoteTrigger('Pay @fri 3pm', ['Friday 3pm sync'])).toBeNull()
  })

  it('ignores an `@` inside a word', () => {
    expect(findNoteTrigger('mail kaan@memry', [])).toBeNull()
  })
})

function TitleInput(): ReactNode {
  useHintActivation()
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const picker = useTitleNotePicker(value, inputRef, setValue)
  return (
    <span>
      <input
        ref={inputRef}
        aria-label="Task name"
        value={value}
        {...picker.inputProps}
        onChange={(e) => {
          setValue(e.target.value)
          picker.trackCaret(e.currentTarget)
        }}
        onKeyDown={(e) => picker.handleKeyDown(e)}
      />
      {picker.picker}
    </span>
  )
}

function renderTitleInput(): HTMLElement {
  Element.prototype.scrollIntoView = vi.fn()
  render(
    <HintModeProvider>
      <TitleInput />
    </HintModeProvider>
  )
  return screen.getByRole('combobox', { name: 'Task name' })
}

describe('useTitleNotePicker', () => {
  it('writes the highlighted note into the title as a link', () => {
    const input = renderTitleInput()
    input.focus()
    fireEvent.change(input, { target: { value: 'Call @Road', selectionStart: 10 } })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const picked = screen.getAllByRole('option')[1].textContent ?? ''
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input).toHaveProperty('value', `Call [[${picked.trim()}]] `)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes the list on Esc and keeps the half-typed title in the field', () => {
    const input = renderTitleInput()
    input.focus()
    fireEvent.change(input, { target: { value: 'Call @Ro', selectionStart: 8 } })
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(input.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id)

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    // Focus stayed, so blur never committed `Call @Ro` as the title.
    expect(document.activeElement).toBe(input)
  })
})
