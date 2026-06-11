import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { Button } from '@/components/ui/button'
import { SYNC_PLAN_TIERS, type CheckoutPlanId } from '@/lib/constants'
import { openPaddleCheckout, type PaddleCheckoutCadence } from '@/lib/paddle-checkout'
import {
  getCheckoutSummary,
  getSelectableCadences,
  normalizeCadenceForPlan,
  parseCheckoutToken
} from '@/lib/checkout-summary'
import { cn } from '@/lib/utils'

const PURCHASABLE_TIERS = SYNC_PLAN_TIERS.filter((tier) => tier.checkoutPlanId)

type CheckoutStatus = 'idle' | 'starting' | 'pending' | 'success' | 'failed' | 'canceled'

export function CheckoutPage() {
  const [token, setToken] = useState<string | null>(null)
  const [plan, setPlan] = useState<CheckoutPlanId>('pro')
  const [cadence, setCadence] = useState<PaddleCheckoutCadence>('annual')
  const [status, setStatus] = useState<CheckoutStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const completedRef = useRef(false)

  useEffect(() => {
    setToken(parseCheckoutToken(window.location.hash))
  }, [])

  const effectiveCadence = normalizeCadenceForPlan(plan, cadence)
  const summary = useMemo(
    () => getCheckoutSummary(plan, effectiveCadence),
    [plan, effectiveCadence]
  )
  const cadenceOptions = getSelectableCadences(plan)

  const selectPlan = (next: CheckoutPlanId) => {
    setPlan(next)
    setCadence((current) => normalizeCadenceForPlan(next, current))
  }

  const proceed = async () => {
    if (!token) return
    setStatus('starting')
    setError(null)
    completedRef.current = false
    try {
      await openPaddleCheckout(plan, effectiveCadence, token, (event) => {
        if (event.name === 'checkout.completed') {
          completedRef.current = true
          setStatus('success')
        } else if (event.name === 'checkout.closed' && !completedRef.current) {
          setStatus('canceled')
        } else if (event.name === 'checkout.payment.failed') {
          setStatus('failed')
        }
      })
      setStatus((current) => (current === 'starting' ? 'pending' : current))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout')
      setStatus('idle')
    }
  }

  return (
    <>
      <PageHead page="pricing" />
      <main className="py-16">
        <Container>
          {!token ? (
            <NoTokenNotice />
          ) : (
            <div className="grid gap-10 md:grid-cols-2">
              <section>
                <p className="text-sm text-muted">Account · Sync · Checkout</p>
                <h1 className="mt-2 text-2xl font-semibold">Choose a sync plan</h1>

                <h2 className="mt-8 text-sm font-medium uppercase tracking-wide">Plan</h2>
                <div className="mt-3 space-y-2">
                  {PURCHASABLE_TIERS.map((tier) => (
                    <button
                      key={tier.id}
                      type="button"
                      onClick={() => selectPlan(tier.checkoutPlanId!)}
                      className={cn(
                        'flex w-full flex-col rounded-lg border p-4 text-start transition',
                        plan === tier.checkoutPlanId
                          ? 'border-primary ring-1 ring-primary'
                          : 'border-border hover:border-foreground/30'
                      )}
                    >
                      <span className="font-medium">{tier.name}</span>
                      <span className="text-sm text-muted">{tier.tagline}</span>
                    </button>
                  ))}
                </div>

                {cadenceOptions.length > 1 && (
                  <>
                    <h2 className="mt-8 text-sm font-medium uppercase tracking-wide">
                      Renewal frequency
                    </h2>
                    <div className="mt-3 space-y-2">
                      {cadenceOptions.map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => setCadence(option)}
                          className={cn(
                            'flex w-full items-center justify-between rounded-lg border p-4 text-start transition',
                            effectiveCadence === option
                              ? 'border-primary ring-1 ring-primary'
                              : 'border-border hover:border-foreground/30'
                          )}
                        >
                          <span>{option === 'annual' ? 'Yearly' : 'Monthly'}</span>
                          {option === 'annual' && (
                            <span className="text-xs font-medium text-emerald-600">SAVE 20%</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </section>

              <OrderSummary summary={summary} status={status} error={error} onProceed={proceed} />
            </div>
          )}
        </Container>
      </main>
    </>
  )
}

function OrderSummary({
  summary,
  status,
  error,
  onProceed
}: {
  summary: ReturnType<typeof getCheckoutSummary>
  status: CheckoutStatus
  error: string | null
  onProceed: () => void
}) {
  if (!summary) {
    return (
      <aside className="rounded-lg border border-border p-6">
        <p className="text-sm text-muted">This plan is not available for purchase.</p>
      </aside>
    )
  }

  const isBusy = status === 'starting' || status === 'pending'

  return (
    <aside className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted">Billing frequency</span>
        <span className="font-medium">{summary.billingFrequencyLabel}</span>
      </div>
      <div className="mt-4 flex items-center justify-between text-sm">
        <span>{summary.lineItemLabel}</span>
        <span>${summary.amount.toFixed(2)}</span>
      </div>
      <hr className="my-6 border-border" />
      <div className="flex items-center justify-between">
        <span className="text-lg font-semibold">Total</span>
        <span className="text-lg font-semibold">
          {summary.currency} ${summary.amount.toFixed(2)}
        </span>
      </div>

      {status === 'success' && (
        <p role="status" className="mt-4 text-sm text-emerald-600">
          Payment complete. Return to Memry to finish activation.
        </p>
      )}
      {status === 'canceled' && (
        <p role="status" className="mt-4 text-sm text-muted">
          Checkout canceled.
        </p>
      )}
      {status === 'failed' && (
        <p role="alert" className="mt-4 text-sm text-terracotta">
          Payment failed. Please try again.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-terracotta">
          {error}
        </p>
      )}

      <Button type="button" className="mt-6 w-full" disabled={isBusy} onClick={onProceed}>
        {isBusy ? 'Opening…' : 'Proceed to payment'}
      </Button>
    </aside>
  )
}

function NoTokenNotice() {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-border p-8 text-center">
      <h1 className="text-xl font-semibold">Open Memry to upgrade</h1>
      <p className="mt-3 text-sm text-muted">
        Start checkout from <strong>Settings → Account</strong> in the Memry desktop app so we can
        link the purchase to your account.
      </p>
      <Button asChild className="mt-6">
        <Link to="/download/desktop">Download Memry</Link>
      </Button>
    </div>
  )
}
