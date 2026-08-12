/**
 * The naming field on its own — the two guarantees it owes the row above it
 * that no test driving the whole tree can isolate.
 *
 * Both are covered here rather than through `CanvasTree` because the row ALSO
 * guards itself while a field is open: through the tree, either guard alone is
 * enough to keep the suite green, so neither one is actually proven.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CanvasRowNameInput, type CanvasRowEdit } from './canvas-row-name-input'

function makeEdit(overrides: Partial<CanvasRowEdit> = {}): CanvasRowEdit {
  return {
    value: 'Alpha',
    busy: false,
    error: null,
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides
  }
}

describe('CanvasRowNameInput', () => {
  it('keeps its keystrokes out of the row it is rendered in', () => {
    // The row's own F2 and Delete shortcuts live one React parent up, and
    // synthetic events bubble there, so typing a name would otherwise fire
    // them. A React parent, not a DOM one: stopping a synthetic event does not
    // stop the native one from bubbling through the real DOM.
    const onKeyDown = vi.fn()
    render(
      <div onKeyDown={onKeyDown}>
        <CanvasRowNameInput edit={makeEdit()} ariaLabel="name" />
      </div>
    )

    const input = screen.getByLabelText('name')
    fireEvent.keyDown(input, { key: 'Delete' })
    fireEvent.keyDown(input, { key: 'F2' })
    fireEvent.keyDown(input, { key: 'Backspace' })
    fireEvent.keyDown(input, { key: 'a' })

    expect(onKeyDown).not.toHaveBeenCalled()
  })

  it('pulls focus back to the field when a name is refused after focus left it', async () => {
    // Blur is a commit, so a refusal can arrive while the user is somewhere
    // else entirely — and the reason would then sit on a field nobody is in.
    const { rerender } = render(
      <>
        <button type="button">elsewhere</button>
        <CanvasRowNameInput edit={makeEdit()} ariaLabel="name" />
      </>
    )

    const input = screen.getByLabelText('name')
    const elsewhere = screen.getByRole('button')
    await waitFor(() => expect(input).toHaveFocus())

    elsewhere.focus()
    expect(input).not.toHaveFocus()

    rerender(
      <>
        <button type="button">elsewhere</button>
        <CanvasRowNameInput edit={makeEdit({ error: 'That name is taken.' })} ariaLabel="name" />
      </>
    )

    expect(input).toHaveFocus()
    expect(screen.getByRole('alert')).toHaveTextContent('That name is taken.')
  })
})
