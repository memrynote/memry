import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { askPermanentDelete, current } from '@/lib/permanent-delete-question'
import { PermanentDeleteConfirm } from './permanent-delete-confirm'

const deleteButton = () => screen.getByRole('button', { name: 'Delete permanently' })

/** Waits until the shown question can be answered with a permanent delete. */
async function armed(title: string): Promise<void> {
  expect(await screen.findByText(new RegExp(title))).toBeInTheDocument()
  await waitFor(() => expect(deleteButton()).toBeEnabled())
}

describe('PermanentDeleteConfirm', () => {
  it('answers the note it shows, then shows the next', async () => {
    const user = userEvent.setup()
    render(<PermanentDeleteConfirm />)
    const first = askPermanentDelete('id-Plan', 'Plan')
    const second = askPermanentDelete('id-Notes', 'Notes')

    await armed('Plan')
    await user.click(deleteButton())
    expect(await first).toBe(true)
    // The dialog's close is not taken for an answer to the next note.
    expect(current()?.title).toBe('Notes')
    await armed('Notes')

    await user.click(screen.getByRole('button', { name: 'Keep note' }))
    expect(await second).toBe(false)
    expect(current()).toBeNull()
  })

  it('does not delete the next note on a double click meant for the last', async () => {
    const user = userEvent.setup()
    render(<PermanentDeleteConfirm />)
    const first = askPermanentDelete('id-One', 'One')
    const second = askPermanentDelete('id-Two', 'Two')

    await armed('One')
    // A double click: its second click lands on the same spot, which is the next question's
    // button by then.
    await user.click(deleteButton())
    await user.click(deleteButton())
    expect(await first).toBe(true)
    expect(current()?.title).toBe('Two')

    // Escape keeps the note.
    await armed('Two')
    await user.keyboard('{Escape}')
    expect(await second).toBe(false)
    expect(current()).toBeNull()
  })

  it('keeps the next note on an Enter meant for the last: focus starts on Keep', async () => {
    const user = userEvent.setup()
    render(<PermanentDeleteConfirm />)
    const first = askPermanentDelete('id-One', 'One')
    const second = askPermanentDelete('id-Two', 'Two')

    await armed('One')
    await user.click(deleteButton())
    expect(await first).toBe(true)
    expect(await screen.findByText(/Two/)).toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(await second).toBe(false)
    expect(current()).toBeNull()
  })
})
