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

// Vault-relative, the way `useNoteTreeData` hands them over: `notes` is a real
// folder in the sidebar, not a root prefix to strip.
const nested = new Map([['note-1', { path: 'notes/Work/Nested/Alpha.md' }]])
const oneFolderDeep = new Map([['note-1', { path: 'movies/Untitled.md' }]])
const atVaultRoot = new Map([['note-1', { path: 'Untitled.md' }]])

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

    expect(mocks.expandNode).toHaveBeenCalledWith('folder-notes')
    expect(mocks.expandNode).toHaveBeenCalledWith('folder-notes/Work')
    expect(mocks.expandNode).toHaveBeenCalledWith('folder-notes/Work/Nested')

    act(() => void vi.advanceTimersByTime(50))
    expect(onReveal).toHaveBeenCalledWith('note-1')
    expect(onClear).not.toHaveBeenCalled()
  })

  it('opens the folder of a note sitting one level down', () => {
    // The regression: the first path segment used to be dropped as a vault-root
    // prefix, so a note in a top-level folder — where `defaultNoteFolder` puts
    // every new note — expanded nothing and stayed hidden.
    const onReveal = vi.fn()

    render(
      <RevealHandler
        pendingRevealNoteId="note-1"
        noteMap={oneFolderDeep}
        onReveal={onReveal}
        onClear={vi.fn()}
      />
    )

    expect(mocks.expandNode).toHaveBeenCalledWith('folder-movies')

    act(() => void vi.advanceTimersByTime(50))
    expect(onReveal).toHaveBeenCalledWith('note-1')
  })

  it('reveals a note at the vault root without expanding anything', () => {
    const onReveal = vi.fn()

    render(
      <RevealHandler
        pendingRevealNoteId="note-1"
        noteMap={atVaultRoot}
        onReveal={onReveal}
        onClear={vi.fn()}
      />
    )

    expect(mocks.expandNode).not.toHaveBeenCalled()

    act(() => void vi.advanceTimersByTime(50))
    expect(onReveal).toHaveBeenCalledWith('note-1')
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

    expect(mocks.expandNode).toHaveBeenCalledWith('folder-notes/Work/Nested')
    act(() => void vi.advanceTimersByTime(50))
    expect(onReveal).toHaveBeenCalledWith('note-1')
  })

  it('expands once per request, not once per render', () => {
    // Creating a note re-renders the sidebar repeatedly and none of the props
    // here are stable, so a per-render expand would re-open a folder the moment
    // the user collapses it.
    const props = {
      pendingRevealNoteId: 'note-1',
      onReveal: vi.fn(),
      onClear: vi.fn()
    }

    const { rerender } = render(<RevealHandler {...props} noteMap={oneFolderDeep} />)
    expect(mocks.expandNode).toHaveBeenCalledTimes(1)

    // A refetch hands over a fresh Map with the same contents.
    rerender(<RevealHandler {...props} noteMap={new Map(oneFolderDeep)} />)
    expect(mocks.expandNode).toHaveBeenCalledTimes(1)

    // The request still completes.
    act(() => void vi.advanceTimersByTime(50))
    expect(props.onReveal).toHaveBeenCalledWith('note-1')
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
