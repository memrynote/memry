import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarProvider } from '@/components/ui/sidebar'
import type * as Bindings from '../../../generated/bindings'
import { NavUser } from './nav-user'

const billing = vi.hoisted(() => ({ accountStartCheckout: vi.fn() }))
vi.mock('../../../generated/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof Bindings>()
  return { ...actual, commands: { ...actual.commands, ...billing } }
})
vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ open: vi.fn() })
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const user = { name: 'Kaan', email: 'kaan@example.com', avatar: '' }

async function clickUpgrade(): Promise<HTMLElement> {
  render(
    <SidebarProvider>
      <NavUser user={user} />
    </SidebarProvider>
  )
  await userEvent.click(screen.getByRole('button', { name: /Kaan/ }))
  const upgrade = await screen.findByRole('menuitem', { name: /upgrade/i })
  await userEvent.click(upgrade)
  return upgrade
}

describe('NavUser upgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    billing.accountStartCheckout.mockReset()
  })

  it('shows the refusal the checkout answers and enables the button again', async () => {
    billing.accountStartCheckout.mockResolvedValue({
      success: false,
      error: 'Sign in to start checkout'
    })

    const upgrade = await clickUpgrade()

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Sign in to start checkout'))
    expect(billing.accountStartCheckout).toHaveBeenCalledWith(null)
    expect(toast.success).not.toHaveBeenCalled()
    await waitFor(() => expect(upgrade).not.toHaveAttribute('aria-disabled'))
  })

  it('shows a toast when the checkout command rejects and enables the button again', async () => {
    billing.accountStartCheckout.mockRejectedValue({
      kind: 'internal',
      code: 'billing_unavailable'
    })

    const upgrade = await clickUpgrade()

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(toast.success).not.toHaveBeenCalled()
    await waitFor(() => expect(upgrade).not.toHaveAttribute('aria-disabled'))
  })
})
