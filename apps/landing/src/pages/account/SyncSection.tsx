import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CheckoutPanel,
  type CurrentSubscription,
  type PlanChangePreview,
  type PlanChangeTarget
} from '@/components/account/CheckoutPanel'
import { parseCheckoutToken, readCheckoutTokenClaims } from '@/lib/checkout-summary'
import { useAuth } from '@/contexts/auth-context'

interface BillingStatus {
  plan: 'free' | 'plus' | 'pro' | 'believer'
  cadence: 'monthly' | 'annual' | 'lifetime' | null
  status: string
}

export function SyncSection() {
  const { api } = useAuth()
  // Desktop opens /account/sync#token=<checkoutToken>; that token already
  // scopes the purchase to the account, so no web session (or mint) is needed.
  const [hashToken] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : parseCheckoutToken(window.location.hash)
  )
  const [mintedToken, setMintedToken] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [billing, setBilling] = useState<BillingStatus | null>(null)
  const [billingLoaded, setBillingLoaded] = useState(false)

  useEffect(() => {
    if (hashToken) return
    api
      .authedJson<{ checkoutToken: string }>('/auth/checkout-token', { method: 'POST' })
      .then((r) => setMintedToken(r.checkoutToken))
      .catch(() => setError(true))
  }, [api, hashToken])

  // Without this the panel is a pure first-purchase screen and would happily sell a second,
  // parallel subscription to someone who already pays.
  useEffect(() => {
    api
      .authedJson<BillingStatus>('/auth/billing')
      .then(setBilling)
      .catch(() => setBilling(null))
      .finally(() => setBillingLoaded(true))
  }, [api])

  const previewPlanChange = useCallback(
    (target: PlanChangeTarget) =>
      api.authedJson<PlanChangePreview>('/auth/billing/change-plan/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target)
      }),
    [api]
  )

  const applyPlanChange = useCallback(
    async (target: PlanChangeTarget) => {
      const next = await api.authedJson<BillingStatus>('/auth/billing/change-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target)
      })
      setBilling(next)
    },
    [api]
  )

  const token = hashToken ?? mintedToken
  const current: CurrentSubscription | null = useMemo(() => {
    if (!billing || billing.plan === 'free' || billing.status !== 'active') return null
    return { plan: billing.plan, cadence: billing.cadence }
  }, [billing])

  // Deep-linked from desktop with no web session: the signed token still says whether this
  // account pays, which is enough to refuse showing a second checkout.
  const tokenSaysSubscribed = !billing && readCheckoutTokenClaims(token)?.hasSubscription === true

  return (
    <div className="space-y-6">
      <h1 className="font-editorial text-2xl tracking-[-0.01em]">Sync</h1>
      {!token && error ? (
        <p className="text-sm text-red-500">Could not start checkout. Reload to try again.</p>
      ) : !token || !billingLoaded ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : tokenSaysSubscribed ? (
        <p className="text-sm text-muted">
          This account already has an active subscription. Change your plan from{' '}
          <strong className="font-medium text-ink">Settings → Account</strong> in the Memrynote
          desktop app, or sign in here on the web to switch it.
        </p>
      ) : (
        <CheckoutPanel
          token={token}
          current={current}
          onPreviewPlanChange={previewPlanChange}
          onApplyPlanChange={applyPlanChange}
        />
      )}
    </div>
  )
}
