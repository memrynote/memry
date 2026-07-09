import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApplyTemplateConfirmDialog } from './apply-template-confirm-dialog'

describe('ApplyTemplateConfirmDialog', () => {
  it('calls onConfirm with full then body, and onCancel', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const user = userEvent.setup()

    const { rerender } = render(
      <ApplyTemplateConfirmDialog
        isOpen
        templateName="Meeting"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )

    await user.click(screen.getByText('Replace content & add template details'))
    expect(onConfirm).toHaveBeenCalledWith('full')

    rerender(
      <ApplyTemplateConfirmDialog
        isOpen
        templateName="Meeting"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )
    await user.click(screen.getByText('Replace content only'))
    expect(onConfirm).toHaveBeenCalledWith('body')

    await user.click(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalled()
  })
})
