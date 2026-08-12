import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { NotesTreeTruncationNotice } from './note-tree-states'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.count === undefined ? key : `${key}:${values.count}`
  })
}))

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
