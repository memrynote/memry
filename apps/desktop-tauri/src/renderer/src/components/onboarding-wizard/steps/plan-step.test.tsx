import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ state: { email: 'kaan@example.com' } })
}))

const account = vi.hoisted(() => ({
  accountStartCheckout: vi.fn(),
  accountRefreshBillingStatus: vi.fn()
}))
vi.mock('../../../../../generated/bindings', () => ({ commands: account }))

import { initialDraft, type WizardState } from '../wizard-model'
import { PlanStep } from './plan-step'

const state: WizardState = { path: 'new', step: 'plan', draft: initialDraft(true) }

describe('plan step', () => {
  beforeEach(() => {
    vi.useRealTimers()
    account.accountStartCheckout.mockReset().mockResolvedValue({ success: true })
    account.accountRefreshBillingStatus
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
    expect(account.accountStartCheckout).toHaveBeenCalledWith({ plan: 'pro', cadence: 'annual' })
    expect(screen.getByText('onboardingWizard.plan.waiting')).toBeInTheDocument()
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'next' })

    account.accountRefreshBillingStatus.mockResolvedValue({
      plan: 'pro',
      status: 'active',
      expiresAt: null
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'update', patch: { paidPlan: 'pro' } })
    )
    expect(dispatch).toHaveBeenCalledWith({ type: 'next' })
  })

  // The server sends `expiresAt` in epoch seconds; a subscription always has one.
  it('moves on for a paid subscription that renews later', async () => {
    const renewsAt = Math.floor(Date.now() / 1000) + 30 * 24 * 3600
    account.accountRefreshBillingStatus.mockResolvedValue({
      plan: 'plus',
      status: 'active',
      expiresAt: renewsAt
    })
    const dispatch = vi.fn()
    render(<PlanStep state={state} dispatch={dispatch} />)

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'update', patch: { paidPlan: 'plus' } })
    )
  })

  it('stays on the step when the plan has expired', async () => {
    account.accountRefreshBillingStatus.mockResolvedValue({
      plan: 'plus',
      status: 'active',
      expiresAt: Math.floor(Date.now() / 1000) - 60
    })
    const dispatch = vi.fn()
    render(<PlanStep state={state} dispatch={dispatch} />)

    await waitFor(() => expect(account.accountRefreshBillingStatus).toHaveBeenCalledWith(null))
    await act(async () => {
      await Promise.resolve()
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('continues without a plan when the user skips', async () => {
    const dispatch = vi.fn()
    render(<PlanStep state={state} dispatch={dispatch} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /plan\.notNow/ }))
    })
    expect(dispatch).toHaveBeenCalledWith({ type: 'update', patch: { paidPlan: null } })
    expect(account.accountStartCheckout).not.toHaveBeenCalled()
  })
})
