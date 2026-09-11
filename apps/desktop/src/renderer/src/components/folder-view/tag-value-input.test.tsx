import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { TagValueInput } from './tag-value-input'
import type { TagSuggestion } from '@/lib/tag-suggestions'

const suggestions: TagSuggestion[] = [
  { name: 'inbox', count: 40 },
  { name: 'work', color: 'blue', count: 30 },
  { name: 'work/design', count: 20 },
  { name: 'personal', count: 10 },
  { name: 'reading', count: 5 },
  { name: 'archive', count: 1 }
]

/** Controlled wrapper: the real caller feeds the value back on every change. */
function Harness({ onChange }: { onChange?: (value: string) => void }): React.JSX.Element {
  const [value, setValue] = useState('')
  return (
    <TagValueInput
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
      suggestions={suggestions}
      placeholder="Value"
    />
  )
}

const openList = (): HTMLElement => {
  const input = screen.getByRole('combobox')
  fireEvent.focus(input)
  return input
}

describe('TagValueInput', () => {
  it('offers the five most-used tags on focus and nothing before it', () => {
    render(<Harness />)
    expect(screen.queryByRole('listbox')).toBeNull()

    openList()

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'inbox40',
      'work30',
      'work/design20',
      'personal10',
      'reading5'
    ])
  })

  it('re-ranks on every keystroke', () => {
    render(<Harness />)
    const input = openList()

    fireEvent.change(input, { target: { value: 'des' } })

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['work/design20'])
  })

  it('fills the value from the highlighted tag on Enter and closes the list', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const input = openList()

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenLastCalledWith('work/design')
    expect(input).toHaveValue('work/design')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('wraps the highlight upward from the first item', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const input = openList()

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenLastCalledWith('reading')
  })

  it('fills the value from a clicked tag', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    openList()

    fireEvent.click(screen.getByRole('option', { name: /personal/ }))

    expect(onChange).toHaveBeenLastCalledWith('personal')
  })

  it('closes on Escape without clearing what was typed', () => {
    render(<Harness />)
    const input = openList()
    fireEvent.change(input, { target: { value: 'work' } })

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input).toHaveValue('work')
  })

  it('leaves Enter alone when no suggestion is showing', () => {
    render(<Harness />)
    const input = openList()
    fireEvent.change(input, { target: { value: 'nothing-matches-this' } })

    expect(screen.queryByRole('listbox')).toBeNull()
    const enter = fireEvent.keyDown(input, { key: 'Enter' })

    // Not swallowed: the filter popover still gets its Enter.
    expect(enter).toBe(true)
  })
})
