/**
 * RevealHandler — the piece that turns "reveal this note" into open folders.
 *
 * The case worth pinning is the one that used to fail silently: a note created
 * a moment ago is not in the tree query yet, and dropping the request there is
 * what made a brand-new note impossible to reveal.
 */

import { render } from '@testing-library/react'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RevealHandler } from './note-tree-internal'

const mocks = vi.hoisted(() => ({ expandNode: vi.fn() }))

vi.mock('@/components/kibo-ui/tree', () => ({
  useTree: () => ({ expandNode: mocks.expandNode, expandedIds: new Set(), toggleExpanded: vi.fn() })
}))

vi.mock('@/components/note/note-breadcrumb', () => ({
  SIDEBAR_REVEAL_FOLDER_EVENT: 'sidebar-reveal-folder'
}))

vi.mock('@/components/folder-icon-button', () => ({
  FolderIconButton: () => null
}))

const nested = new Map([['note-1', { path: 'notes/Work/Nested/Alpha.md' }]])

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RevealHandler', () => {
  it('opens every folder on the note path, then reports the reveal', () => {
    const onReveal = vi.fn()
    const onClear = vi.fn()

    render(
      <RevealHandler
        pendingRevealNoteId="note-1"
        noteMap={nested}
        onReveal={onReveal}
        onClear={onClear}
      />
    )

    expect(mocks.expandNode).toHaveBeenCalledWith('folder-Work')
    expect(mocks.expandNode).toHaveBeenCalledWith('folder-Work/Nested')

    act(() => void vi.advanceTimersByTime(50))
    expect(onReveal).toHaveBeenCalledWith('note-1')
    expect(onClear).not.toHaveBeenCalled()
  })

  it('waits for a note the tree has not loaded yet, then reveals it', () => {
    const onReveal = vi.fn()
    const onClear = vi.fn()

    const { rerender } = render(
      <RevealHandler
        pendingRevealNoteId="note-1"
        noteMap={new Map()}
        onReveal={onReveal}
        onClear={onClear}
      />
    )

    // Nothing yet — and, crucially, the request is not thrown away.
    expect(mocks.expandNode).not.toHaveBeenCalled()
    expect(onClear).not.toHaveBeenCalled()

    // The list query refetches and the note arrives.
    rerender(
      <RevealHandler
        pendingRevealNoteId="note-1"
        noteMap={nested}
        onReveal={onReveal}
        onClear={onClear}
      />
    )

    expect(mocks.expandNode).toHaveBeenCalledWith('folder-Work/Nested')
    act(() => void vi.advanceTimersByTime(50))
    expect(onReveal).toHaveBeenCalledWith('note-1')
  })

  it('gives up on a note that never arrives', () => {
    const onReveal = vi.fn()
    const onClear = vi.fn()

    render(
      <RevealHandler
        pendingRevealNoteId="note-gone"
        noteMap={new Map()}
        onReveal={onReveal}
        onClear={onClear}
      />
    )

    act(() => void vi.advanceTimersByTime(5000))

    expect(onClear).toHaveBeenCalledTimes(1)
    expect(onReveal).not.toHaveBeenCalled()
  })

  it('does nothing without a pending note', () => {
    const onClear = vi.fn()

    render(
      <RevealHandler
        pendingRevealNoteId={null}
        noteMap={nested}
        onReveal={vi.fn()}
        onClear={onClear}
      />
    )

    act(() => void vi.advanceTimersByTime(5000))
    expect(mocks.expandNode).not.toHaveBeenCalled()
    expect(onClear).not.toHaveBeenCalled()
  })
})
