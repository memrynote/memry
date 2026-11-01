import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { askPermanentDelete, current } from '@/lib/permanent-delete-question'
import { PermanentDeleteConfirm } from './permanent-delete-confirm'

describe('PermanentDeleteConfirm', () => {
  it('answers the note it shows, then shows the next', async () => {
    const user = userEvent.setup()
    render(<PermanentDeleteConfirm />)
    const first = askPermanentDelete('Plan')
    const second = askPermanentDelete('Notes')

    expect(await screen.findByText(/Plan/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }))
    expect(await first).toBe(true)
    // The dialog's close is not taken for an answer to the next note.
    expect(current()?.title).toBe('Notes')
    expect(await screen.findByText(/Notes/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Keep note' }))
    expect(await second).toBe(false)
    expect(current()).toBeNull()
  })
})
