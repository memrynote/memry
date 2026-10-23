import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ state: { email: 'kaan@example.com' } })
}))

import { initialDraft, type WizardState } from '../wizard-model'
import { PlanStep } from './plan-step'

const account = {
  startCheckout: vi.fn(),
  refreshBillingStatus: vi.fn()
}
;(window.api as unknown as { account: typeof account }).account = account

const state: WizardState = { path: 'new', step: 'plan', draft: initialDraft(true) }

describe('plan step', () => {
  beforeEach(() => {
    vi.useRealTimers()
    account.startCheckout.mockReset().mockResolvedValue({ success: true })
    account.refreshBillingStatus
      .mockReset()
      .mockResolvedValue({ plan: 'free', status: 'active', expiresAt: null })
  })

  it('opens checkout with the chosen plan and moves on once the payment goes through', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const dispatch = vi.fn()
    render(<PlanStep state={state} dispatch={dispatch} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /plan\.continue/ }))
    })
    expect(account.startCheckout).toHaveBeenCalledWith({ plan: 'pro', cadence: 'annual' })
    expect(screen.getByText('onboardingWizard.plan.waiting')).toBeInTheDocument()
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'next' })

    account.refreshBillingStatus.mockResolvedValue({
      plan: 'pro',
      status: 'active',
      expiresAt: null
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({ type: 'update', patch: { paidPlan: 'pro' } })
    })
    expect(dispatch).toHaveBeenCalledWith({ type: 'next' })
  })

  it('continues without a plan when the user skips', async () => {
    const dispatch = vi.fn()
    render(<PlanStep state={state} dispatch={dispatch} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /plan\.notNow/ }))
    })
    expect(dispatch).toHaveBeenCalledWith({ type: 'update', patch: { paidPlan: null } })
    expect(account.startCheckout).not.toHaveBeenCalled()
  })
})
