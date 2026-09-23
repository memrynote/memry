import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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

/** What the account is on right now. Present = this panel switches an existing subscription. */
export interface CurrentSubscription {
  plan: CheckoutPlanId | 'free'
  cadence: 'monthly' | 'annual' | 'lifetime' | null
}

export interface PlanChangePreview {
  isUpgrade: boolean
  effective: 'immediate' | 'next_billing_period'
  /** Minor units, as Paddle reports them. */
  immediateChargeAmount: string | null
  recurringAmount: string
  currencyCode: string
  nextBilledAt: string | null
}

export type PlanChangeTarget = { plan: 'plus' | 'pro'; cadence: 'monthly' | 'annual' }

type ChangeStatus = 'idle' | 'applying' | 'done'

function isChangeTarget(
  plan: CheckoutPlanId,
  cadence: PaddleCheckoutCadence
): PlanChangeTarget | null {
  if (plan === 'believer') return null
  if (cadence !== 'monthly' && cadence !== 'annual') return null
  return { plan, cadence }
}

/** Paddle reports money in minor units; `"4349"` is $43.49. */
function formatMinorUnits(amount: string, currency: string) {
  const value = Number(amount) / 100
  if (!Number.isFinite(value)) return `${amount} ${currency}`
  return `$${value.toFixed(2)}`
}

function formatDate(iso: string | null) {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

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
  /**
   * Set for an account that already pays. The panel then switches the existing subscription
   * (prorated by Paddle) instead of selling a second, parallel one.
   */
  current?: CurrentSubscription | null
  onPreviewPlanChange?: (target: PlanChangeTarget) => Promise<PlanChangePreview>
  onApplyPlanChange?: (target: PlanChangeTarget) => Promise<void>
}

export function CheckoutPanel({
  token,
  onTokenMissing,
  initialPlan = 'pro',
  initialCadence = 'annual',
  current = null,
  onPreviewPlanChange,
  onApplyPlanChange
}: CheckoutPanelProps) {
  const isChangeMode = Boolean(
    current && current.plan !== 'free' && onPreviewPlanChange && onApplyPlanChange
  )
  const [plan, setPlan] = useState<CheckoutPlanId>(() =>
    isChangeMode && current ? (current.plan as CheckoutPlanId) : initialPlan
  )
  const [cadence, setCadence] = useState<PaddleCheckoutCadence>(() =>
    isChangeMode && current?.cadence
      ? normalizeCadenceForPlan(current.plan as CheckoutPlanId, current.cadence)
      : normalizeCadenceForPlan(initialPlan, initialCadence)
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

  const changeTarget = isChangeMode ? isChangeTarget(plan, effectiveCadence) : null
  const isCurrentSelection = Boolean(
    current && current.plan === plan && (current.cadence ?? 'monthly') === effectiveCadence
  )

  if (!token) {
    return onTokenMissing != null ? <>{onTokenMissing}</> : null
  }

  return (
    <div className="animate-fade-up mx-auto max-w-md">
      <p className="font-mono-accent text-[11px] uppercase tracking-[0.22em] text-muted">
        memrynote · sync
      </p>
      <h1 className="font-editorial mt-2 text-[28px] leading-none tracking-[-0.02em]">
        {isChangeMode ? 'Change your plan' : 'Choose your plan'}
      </h1>
      <p className="mt-2 text-sm text-muted">
        {isChangeMode
          ? 'We switch your existing subscription and prorate the difference. No second charge.'
          : 'End-to-end encrypted. Cancel anytime, refund within 14 days.'}
      </p>

      <div className="mt-7 overflow-hidden rounded-2xl border border-border bg-card shadow-card">
        <div role="radiogroup" aria-label="Plan" className="space-y-1 p-2">
          {PURCHASABLE_TIERS.map((tier) => {
            const id = tier.checkoutPlanId!
            return (
              <PlanRow
                key={tier.id}
                tier={tier}
                planId={id}
                selected={plan === id}
                summary={getCheckoutSummary(id, normalizeCadenceForPlan(id, cadence))}
                // Believer is a one-time purchase, so an existing subscription cannot be
                // switched onto it through the proration flow.
                disabled={isChangeMode && id === 'believer'}
                isCurrentPlan={isChangeMode && current?.plan === id}
                onSelect={selectPlan}
              />
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

        {isChangeMode && onPreviewPlanChange && onApplyPlanChange ? (
          <ChangeSummary
            target={changeTarget}
            isCurrentSelection={isCurrentSelection}
            onPreview={onPreviewPlanChange}
            onApply={onApplyPlanChange}
          />
        ) : (
          <OrderSummary summary={summary} status={status} error={error} onProceed={proceed} />
        )}
      </div>

      <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted">
        <Lock className="h-3 w-3" strokeWidth={2} />
        {isChangeMode
          ? 'Billed by Paddle · Prorated · Tax by location'
          : 'Secured by Paddle · Tax by location · 14-day refund'}
      </p>

      <p className="mt-2 text-center text-xs text-muted">
        Need help?{' '}
        <a
          href="mailto:kaan@memrynote.com"
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

function PlanRow({
  tier,
  planId,
  selected,
  summary,
  disabled,
  isCurrentPlan,
  onSelect
}: {
  tier: (typeof PURCHASABLE_TIERS)[number]
  planId: CheckoutPlanId
  selected: boolean
  summary: ReturnType<typeof getCheckoutSummary>
  disabled: boolean
  isCurrentPlan: boolean
  onSelect: (plan: CheckoutPlanId) => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={() => onSelect(planId)}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-3 py-3 text-start transition-colors duration-200',
        selected ? 'bg-[var(--color-paper-alt)]' : 'hover:bg-[var(--color-paper-alt)]/60',
        disabled && 'cursor-not-allowed opacity-45 hover:bg-transparent'
      )}
    >
      <span
        className={cn(
          'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition-colors',
          selected ? 'border-terracotta bg-terracotta text-white' : 'border-border text-transparent'
        )}
      >
        <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{tier.name}</span>
          {isCurrentPlan ? (
            <span className="rounded-full bg-sage/15 px-1.5 py-0.5 text-[10px] font-medium text-sage">
              Current plan
            </span>
          ) : (
            tier.ribbon && (
              <span className="rounded-full bg-terracotta/10 px-1.5 py-0.5 text-[10px] font-medium text-terracotta">
                {tier.ribbon}
              </span>
            )
          )}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted">{tier.tagline}</span>
      </span>

      {summary && (
        <span className="text-end leading-tight">
          <span className="font-mono-accent text-sm font-medium tabular-nums text-ink">
            {formatPrice(summary.amount)}
          </span>
          <span className="ms-0.5 text-[11px] text-muted">
            {cadenceSuffix(summary.billingFrequencyLabel)}
          </span>
        </span>
      )}
    </button>
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

/**
 * Order summary for an existing subscriber. Prices come from Paddle's own preview, never from the
 * static price table — the amount due today is a proration the client cannot compute.
 */
function ChangeSummary({
  target,
  isCurrentSelection,
  onPreview,
  onApply
}: {
  target: PlanChangeTarget | null
  isCurrentSelection: boolean
  onPreview: (target: PlanChangeTarget) => Promise<PlanChangePreview>
  onApply: (target: PlanChangeTarget) => Promise<void>
}) {
  if (isCurrentSelection) {
    return (
      <div className="border-t border-border px-5 py-5">
        <p className="text-sm text-muted">
          This is your current plan. Pick a different plan or billing frequency to switch.
        </p>
      </div>
    )
  }

  if (!target) {
    return (
      <div className="border-t border-border px-5 py-5">
        <p className="text-sm text-muted">
          Believer is a one-time purchase.{' '}
          <a
            href="mailto:kaan@memrynote.com"
            className="text-terracotta underline-offset-2 hover:underline"
          >
            Contact us
          </a>{' '}
          to move an existing subscription onto it.
        </p>
      </div>
    )
  }

  // Remounted per target, so a new selection starts from a clean loading state instead of an
  // effect that has to synchronously clear the previous quote.
  return (
    <ChangeQuote
      key={`${target.plan}-${target.cadence}`}
      plan={target.plan}
      cadence={target.cadence}
      onPreview={onPreview}
      onApply={onApply}
    />
  )
}

/** The one-line explanation under "Total due today" for a pending plan switch. */
function quoteDetail(preview: PlanChangePreview, cadence: PlanChangeTarget['cadence']) {
  const recurring = formatMinorUnits(preview.recurringAmount, preview.currencyCode)
  const nextBilledAt = formatDate(preview.nextBilledAt)
  if (preview.effective === 'immediate') {
    const per = cadence === 'annual' ? 'year' : 'month'
    return `Prorated · then ${recurring} per ${per}${nextBilledAt ? ` · next on ${nextBilledAt}` : ''}`
  }
  const when = nextBilledAt ? `on ${nextBilledAt}` : 'at your next renewal'
  return `Takes effect ${when} · then ${recurring}`
}

function quoteButtonLabel(
  status: ChangeStatus,
  preview: PlanChangePreview | null,
  { plan, cadence }: PlanChangeTarget
) {
  if (status === 'applying') return 'Switching\u2026'
  if (status === 'done') return 'Done'
  if (preview?.isUpgrade === false) return 'Schedule change'
  return `Switch to ${plan === 'plus' ? 'Plus' : 'Pro'} ${cadence === 'annual' ? 'yearly' : 'monthly'}`
}

function ChangeQuote({
  plan,
  cadence,
  onPreview,
  onApply
}: {
  plan: PlanChangeTarget['plan']
  cadence: PlanChangeTarget['cadence']
  onPreview: (target: PlanChangeTarget) => Promise<PlanChangePreview>
  onApply: (target: PlanChangeTarget) => Promise<void>
}) {
  const [preview, setPreview] = useState<PlanChangePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<ChangeStatus>('idle')

  useEffect(() => {
    let cancelled = false
    onPreview({ plan, cadence })
      .then((result) => {
        if (!cancelled) setPreview(result)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not price this change')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [plan, cadence, onPreview])

  const apply = async () => {
    setStatus('applying')
    setError(null)
    try {
      await onApply({ plan, cadence })
      setStatus('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the plan')
      setStatus('idle')
    }
  }

  const dueToday = preview?.immediateChargeAmount
    ? formatMinorUnits(preview.immediateChargeAmount, preview.currencyCode)
    : '$0.00'

  return (
    <div className="border-t border-border px-5 py-5">
      <div className="flex items-end justify-between">
        <div>
          <p className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
            Total due today
          </p>
          <p className="mt-1 text-xs text-muted">
            {preview ? quoteDetail(preview, cadence) : 'Calculating\u2026'}
          </p>
        </div>
        <p className="shrink-0 text-end">
          <span className="font-mono-accent text-[28px] font-medium leading-none tabular-nums text-ink">
            {loading || !preview ? '—' : dueToday}
          </span>
          {preview && (
            <span className="ms-1 align-top text-xs text-muted">{preview.currencyCode}</span>
          )}
        </p>
      </div>

      {status === 'done' && (
        <p role="status" className="mt-4 text-sm text-sage">
          Plan updated. Your new plan is active now.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-terracotta">
          {error}
        </p>
      )}

      <Button
        type="button"
        className="mt-5 w-full"
        disabled={loading || !preview || status !== 'idle'}
        onClick={apply}
      >
        {quoteButtonLabel(status, preview, { plan, cadence })}
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
