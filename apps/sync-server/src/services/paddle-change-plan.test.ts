import { describe, it, expect, vi } from 'vitest'
import { applyPlanChange, previewPlanChange } from './paddle-billing'
import { isPlanUpgrade, resolveSubscriptionPriceId } from './paddle-prices'
import type { Bindings } from '../types'

const PRICES = {
  PADDLE_PRICE_PLUS_MONTHLY: 'pri_plus_m',
  PADDLE_PRICE_PLUS_ANNUAL: 'pri_plus_y',
  PADDLE_PRICE_PRO_MONTHLY: 'pri_pro_m',
  PADDLE_PRICE_PRO_ANNUAL: 'pri_pro_y'
}

function createEnv(options: {
  entitlementRow: unknown
  subscription?: Record<string, unknown>
  preview?: Record<string, unknown>
  paddleFetch?: ReturnType<typeof vi.fn>
}) {
  const run = vi.fn().mockResolvedValue({ success: true })
  const paddleFetch =
    options.paddleFetch ??
    vi.fn(async (url: string) => {
      const body = url.endsWith('/preview') ? options.preview : options.subscription
      return new Response(JSON.stringify({ data: body ?? {} }), { status: 200 })
    })

  return {
    env: {
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(options.entitlementRow),
            run
          })
        })
      },
      PADDLE_API_KEY: 'pdl_sandbox_key',
      PADDLE_ENVIRONMENT: 'sandbox' as const,
      ...PRICES,
      fetch: paddleFetch
    } as unknown as Bindings,
    paddleFetch
  }
}

const MONTHLY_SUB = {
  id: 'sub_1',
  status: 'active',
  billing_cycle: { interval: 'month', frequency: 1 },
  next_billed_at: '2026-10-15T16:38:09Z',
  items: [{ price: { id: PRICES.PADDLE_PRICE_PLUS_MONTHLY } }]
}

const PREVIEW = {
  next_billed_at: '2027-09-18T14:47:24Z',
  immediate_transaction: {
    details: { totals: { grand_total: '4349', currency_code: 'USD' } }
  },
  recurring_transaction_details: { totals: { grand_total: '4800', currency_code: 'USD' } }
}

describe('resolveSubscriptionPriceId', () => {
  it('maps plan + cadence to the configured price id', () => {
    const { env } = createEnv({ entitlementRow: null })
    expect(resolveSubscriptionPriceId(env, 'plus', 'annual')).toBe('pri_plus_y')
    expect(resolveSubscriptionPriceId(env, 'pro', 'monthly')).toBe('pri_pro_m')
  })

  it('reports 503 instead of silently picking a wrong price when unconfigured', () => {
    const { env } = createEnv({ entitlementRow: null })
    const bare = { ...env, PADDLE_PRICE_PRO_ANNUAL: undefined } as Bindings
    expect(() => resolveSubscriptionPriceId(bare, 'pro', 'annual')).toThrow(/not configured/)
  })
})

describe('isPlanUpgrade', () => {
  it('treats a longer cadence on the same plan as an upgrade', () => {
    expect(
      isPlanUpgrade({ plan: 'plus', cadence: 'monthly' }, { plan: 'plus', cadence: 'annual' })
    ).toBe(true)
  })

  it('treats a bigger plan as an upgrade even when the cadence shortens', () => {
    expect(
      isPlanUpgrade({ plan: 'plus', cadence: 'annual' }, { plan: 'pro', cadence: 'monthly' })
    ).toBe(true)
  })

  it('treats annual to monthly and pro to plus as downgrades', () => {
    expect(
      isPlanUpgrade({ plan: 'plus', cadence: 'annual' }, { plan: 'plus', cadence: 'monthly' })
    ).toBe(false)
    expect(
      isPlanUpgrade({ plan: 'pro', cadence: 'annual' }, { plan: 'plus', cadence: 'annual' })
    ).toBe(false)
  })
})

describe('previewPlanChange', () => {
  it('prices a monthly to annual upgrade from Paddle, not the static price table', async () => {
    const { env, paddleFetch } = createEnv({
      entitlementRow: { plan: 'plus', paddle_subscription_id: 'sub_1' },
      subscription: MONTHLY_SUB,
      preview: PREVIEW
    })

    const result = await previewPlanChange(env, 'user-1', 'plus', 'annual')

    expect(result).toMatchObject({
      isUpgrade: true,
      effective: 'immediate',
      immediateChargeAmount: '4349',
      recurringAmount: '4800',
      currencyCode: 'USD'
    })

    const previewCall = paddleFetch.mock.calls.find(([url]) => String(url).endsWith('/preview'))
    expect(previewCall).toBeDefined()
    const sent = JSON.parse(String((previewCall?.[1] as RequestInit).body))
    expect(sent.proration_billing_mode).toBe('prorated_immediately')
    expect(sent.items).toEqual([{ price_id: 'pri_plus_y', quantity: 1 }])
    // Paddle keeps stale custom_data unless it is resent, and the webhook writes it back.
    expect(sent.custom_data).toMatchObject({ plan: 'plus', cadence: 'annual', userId: 'user-1' })
  })

  it('defers a downgrade to the next billing period', async () => {
    const { env, paddleFetch } = createEnv({
      entitlementRow: { plan: 'pro', paddle_subscription_id: 'sub_1' },
      subscription: {
        ...MONTHLY_SUB,
        billing_cycle: { interval: 'year', frequency: 1 },
        items: [{ price: { id: PRICES.PADDLE_PRICE_PRO_ANNUAL } }]
      },
      preview: { ...PREVIEW, immediate_transaction: null }
    })

    const result = await previewPlanChange(env, 'user-1', 'pro', 'monthly')

    expect(result.isUpgrade).toBe(false)
    expect(result.effective).toBe('next_billing_period')
    expect(result.immediateChargeAmount).toBeNull()

    const previewCall = paddleFetch.mock.calls.find(([url]) => String(url).endsWith('/preview'))
    const sent = JSON.parse(String((previewCall?.[1] as RequestInit).body))
    expect(sent.proration_billing_mode).toBe('prorated_next_billing_period')
  })

  it('refuses when the account has no subscription to change', async () => {
    const { env } = createEnv({ entitlementRow: { plan: 'free', paddle_subscription_id: null } })
    await expect(previewPlanChange(env, 'user-1', 'plus', 'annual')).rejects.toThrow(
      /No active subscription/
    )
  })

  it('refuses for believer, which is a one-time purchase', async () => {
    const { env } = createEnv({
      entitlementRow: { plan: 'believer', paddle_subscription_id: 'sub_1' }
    })
    await expect(previewPlanChange(env, 'user-1', 'plus', 'annual')).rejects.toThrow(
      /one-time purchase/
    )
  })

  it('refuses to patch a canceled subscription', async () => {
    const { env } = createEnv({
      entitlementRow: { plan: 'plus', paddle_subscription_id: 'sub_1' },
      subscription: { ...MONTHLY_SUB, status: 'canceled' }
    })
    await expect(previewPlanChange(env, 'user-1', 'plus', 'annual')).rejects.toThrow(/canceled/)
  })

  it('refuses a no-op switch so a double click cannot double-charge', async () => {
    const { env } = createEnv({
      entitlementRow: { plan: 'plus', paddle_subscription_id: 'sub_1' },
      subscription: MONTHLY_SUB
    })
    await expect(previewPlanChange(env, 'user-1', 'plus', 'monthly')).rejects.toThrow(
      /Already on this plan/
    )
  })
})

describe('applyPlanChange', () => {
  it('PATCHes the existing subscription instead of creating a second one', async () => {
    const { env, paddleFetch } = createEnv({
      entitlementRow: { plan: 'plus', paddle_subscription_id: 'sub_1' },
      subscription: MONTHLY_SUB
    })

    await applyPlanChange(env, 'user-1', 'plus', 'annual')

    const methods = paddleFetch.mock.calls.map(
      ([, init]) => (init as RequestInit | undefined)?.method
    )
    expect(methods).toContain('PATCH')
    expect(methods).not.toContain('POST')
  })
})
