import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { WikiLinkCreateDialog } from './wiki-link-create-dialog'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params?.title ? `${key}:${params.title}` : key
  })
}))

describe('WikiLinkCreateDialog', () => {
  it('renders nothing while no target is pending', () => {
    render(<WikiLinkCreateDialog targetTitle={null} onClose={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('Create confirms with the pending title and closes', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    render(
      <WikiLinkCreateDialog targetTitle="Ghost Note" onClose={onClose} onConfirm={onConfirm} />
    )

    expect(screen.getByText('wikiLinkCreateDialog.body:Ghost Note')).toBeInTheDocument()
    await user.click(screen.getByText('wikiLinkCreateDialog.create'))

    expect(onConfirm).toHaveBeenCalledWith('Ghost Note')
    expect(onClose).toHaveBeenCalled()
  })

  it('Cancel closes without confirming', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    render(
      <WikiLinkCreateDialog targetTitle="Ghost Note" onClose={onClose} onConfirm={onConfirm} />
    )

    await user.click(screen.getByText('button.cancel'))

    expect(onConfirm).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
