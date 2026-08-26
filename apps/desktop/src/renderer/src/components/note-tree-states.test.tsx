import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { NotesTreeSyncing, NotesTreeTruncationNotice } from './note-tree-states'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.count === undefined ? key : `${key}:${values.count}`
  })
}))

describe('NotesTreeSyncing', () => {
  it('announces the ongoing sync and hosts the composed progress indicator', () => {
    // #given the first full sync is filling a fresh vault (#1830) — the tree
    // is empty, but "create a note to get started" would read as data loss
    render(
      <NotesTreeSyncing>
        <div data-testid="progress-slot" />
      </NotesTreeSyncing>
    )

    // #then it is a live status region with the syncing copy and the
    // composed-in progress indicator, no create-note call to action
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByText('tree.syncing.body')).toBeInTheDocument()
    expect(screen.getByTestId('progress-slot')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('NotesTreeTruncationNotice', () => {
  it('states how many notes the tree is not showing and offers to load them', () => {
    const onLoadMore = vi.fn()
    render(
      <NotesTreeTruncationNotice hiddenCount={2431} isLoadingMore={false} onLoadMore={onLoadMore} />
    )

    expect(screen.getByText('tree.truncated.hidden:2431')).toBeInTheDocument()

    const button = screen.getByRole('button', { name: 'tree.truncated.loadMore' })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('disables the button while the next page is in flight', () => {
    const onLoadMore = vi.fn()
    render(<NotesTreeTruncationNotice hiddenCount={500} isLoadingMore onLoadMore={onLoadMore} />)

    const button = screen.getByRole('button', { name: 'tree.truncated.loadMore' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onLoadMore).not.toHaveBeenCalled()
  })
})
