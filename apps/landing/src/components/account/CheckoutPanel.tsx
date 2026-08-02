import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Check, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SYNC_PLAN_TIERS, type CheckoutPlanId } from '@/lib/constants'
import { openPaddleCheckout, type PaddleCheckoutCadence } from '@/lib/paddle-checkout'
import {
  getCheckoutSummary,
  getSelectableCadences,
  normalizeCadenceForPlan
} from '@/lib/checkout-summary'
import { cn } from '@/lib/utils'

const PURCHASABLE_TIERS = SYNC_PLAN_TIERS.filter((tier) => tier.checkoutPlanId)

type CheckoutStatus = 'idle' | 'starting' | 'pending' | 'success' | 'failed' | 'canceled'

function formatPrice(amount: number) {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`
}

function cadenceSuffix(label: 'Monthly' | 'Yearly' | 'One-time') {
  return label === 'Monthly' ? '/mo' : label === 'Yearly' ? '/yr' : 'once'
}

interface CheckoutPanelProps {
  token: string | null
  onTokenMissing?: ReactNode
  initialPlan?: CheckoutPlanId
  initialCadence?: PaddleCheckoutCadence
}

export function CheckoutPanel({
  token,
  onTokenMissing,
  initialPlan = 'pro',
  initialCadence = 'annual'
}: CheckoutPanelProps) {
  const [plan, setPlan] = useState<CheckoutPlanId>(initialPlan)
  const [cadence, setCadence] = useState<PaddleCheckoutCadence>(() =>
    normalizeCadenceForPlan(initialPlan, initialCadence)
  )
  const [status, setStatus] = useState<CheckoutStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const completedRef = useRef(false)

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

  if (!token) {
    return onTokenMissing != null ? <>{onTokenMissing}</> : null
  }

  return (
    <div className="animate-fade-up mx-auto max-w-md">
      <p className="font-mono-accent text-[11px] uppercase tracking-[0.22em] text-muted">
        memrynote · sync
      </p>
      <h1 className="font-editorial mt-2 text-[28px] leading-none tracking-[-0.02em]">
        Choose your plan
      </h1>
      <p className="mt-2 text-sm text-muted">
        End-to-end encrypted. Cancel anytime, refund within 14 days.
      </p>

      <div className="mt-7 overflow-hidden rounded-2xl border border-border bg-card shadow-card">
        <div role="radiogroup" aria-label="Plan" className="space-y-1 p-2">
          {PURCHASABLE_TIERS.map((tier) => {
            const id = tier.checkoutPlanId!
            const selected = plan === id
            const rowSummary = getCheckoutSummary(id, normalizeCadenceForPlan(id, cadence))
            return (
              <button
                key={tier.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => selectPlan(id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl px-3 py-3 text-start transition-colors duration-200',
                  selected ? 'bg-[var(--color-paper-alt)]' : 'hover:bg-[var(--color-paper-alt)]/60'
                )}
              >
                <span
                  className={cn(
                    'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition-colors',
                    selected
                      ? 'border-terracotta bg-terracotta text-white'
                      : 'border-border text-transparent'
                  )}
                >
                  <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-medium text-ink">{tier.name}</span>
                    {tier.ribbon && (
                      <span className="rounded-full bg-terracotta/10 px-1.5 py-0.5 text-[10px] font-medium text-terracotta">
                        {tier.ribbon}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">{tier.tagline}</span>
                </span>

                {rowSummary && (
                  <span className="text-end leading-tight">
                    <span className="font-mono-accent text-sm font-medium tabular-nums text-ink">
                      {formatPrice(rowSummary.amount)}
                    </span>
                    <span className="ms-0.5 text-[11px] text-muted">
                      {cadenceSuffix(rowSummary.billingFrequencyLabel)}
                    </span>
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {cadenceOptions.length > 1 && (
          <div className="px-3 pb-3">
            <div
              role="radiogroup"
              aria-label="Renewal frequency"
              className="flex rounded-full border border-border bg-[var(--color-paper-alt)] p-1"
            >
              {cadenceOptions.map((option) => {
                const active = effectiveCadence === option
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setCadence(option)}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-200',
                      active ? 'bg-card text-ink shadow-sm' : 'text-muted hover:text-ink'
                    )}
                  >
                    {option === 'annual' ? 'Yearly' : 'Monthly'}
                    {option === 'annual' && <span className="font-semibold text-sage">−20%</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <OrderSummary summary={summary} status={status} error={error} onProceed={proceed} />
      </div>

      <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted">
        <Lock className="h-3 w-3" strokeWidth={2} />
        Secured by Paddle · Tax by location · 14-day refund
      </p>

      <p className="mt-2 text-center text-xs text-muted">
        Need help?{' '}
        <a
          href="mailto:billing@memrynote.com"
          className="text-terracotta underline-offset-2 hover:underline"
        >
          Contact us
        </a>
        .{' '}
        <Link to="/refund" className="text-terracotta underline-offset-2 hover:underline">
          Refund policy
        </Link>
        .
      </p>
    </div>
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
      <div className="border-t border-border px-5 py-5">
        <p className="text-sm text-muted">This plan is not available for purchase.</p>
      </div>
    )
  }

  const isBusy = status === 'starting' || status === 'pending'
  const recurring = summary.billingFrequencyLabel !== 'One-time'

  return (
    <div className="border-t border-border px-5 py-5">
      <div className="flex items-end justify-between">
        <div>
          <p className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
            Total due today
          </p>
          <p className="mt-1 text-xs text-muted">
            {summary.lineItemLabel}
            {recurring && ` · renews ${summary.billingFrequencyLabel.toLowerCase()}`}
          </p>
        </div>
        <p className="shrink-0 text-end">
          <span className="font-mono-accent text-[28px] font-medium leading-none tabular-nums text-ink">
            {formatPrice(summary.amount)}
          </span>
          <span className="ms-1 align-top text-xs text-muted">{summary.currency}</span>
        </p>
      </div>

      {status === 'success' && (
        <p role="status" className="mt-4 text-sm text-sage">
          Payment complete. Return to Memrynote to finish activation.
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

      <Button type="button" className="mt-5 w-full" disabled={isBusy} onClick={onProceed}>
        {isBusy ? (
          'Opening…'
        ) : (
          <>
            <Lock className="h-3.5 w-3.5" strokeWidth={2.25} />
            Proceed to payment
          </>
        )}
      </Button>
    </div>
  )
}

export function NoTokenNotice() {
  return (
    <div className="animate-fade-up mx-auto max-w-sm rounded-2xl border border-border bg-card p-8 text-center shadow-card">
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-terracotta/10 text-terracotta">
        <Lock className="h-5 w-5" strokeWidth={2} />
      </span>
      <h1 className="font-editorial mt-5 text-xl tracking-[-0.01em]">Open Memrynote to upgrade</h1>
      <p className="mt-3 text-sm text-muted">
        Start checkout from <strong className="font-medium text-ink">Settings → Account</strong> in
        the Memrynote desktop app so we can link the purchase to your account.
      </p>
      <Button asChild className="mt-6 w-full">
        <Link to="/download/desktop">Download Memrynote</Link>
      </Button>
    </div>
  )
}
