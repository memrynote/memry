import { useEffect, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { Loader2, Lock } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import type { PlanCadence, PlanId } from '../wizard-model'
import {
  ContinueButton,
  OptionCard,
  OptionList,
  QuietLink,
  StepHeading,
  useDeviceLabel
} from '../wizard-ui'
import type { StepProps } from './basic-steps'

const log = createLogger('Onboarding:Plan')
const K = 'onboardingWizard.plan'
const POLL_MS = 4000

/** Mirrors the landing pricing table (apps/landing pricing tiers). */
const PRICES: Record<PlanId, { monthly: number; annual: number } | { lifetime: number }> = {
  plus: { monthly: 5, annual: 48 },
  pro: { monthly: 10, annual: 96 },
  believer: { lifetime: 500 }
}

const PLANS: PlanId[] = ['plus', 'pro', 'believer']
const BADGE: Partial<Record<PlanId, string>> = { pro: 'popular', believer: 'founding' }

interface BillingSnapshot {
  plan: string
  status: string
  expiresAt: number | null
}

function paidPlanOf(status: unknown): PlanId | null {
  if (!status || typeof status !== 'object' || !('plan' in status)) return null
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- IPC payload; shape is only partially checked above
  const { plan, status: state, expiresAt } = status as BillingSnapshot
  const active = state === 'active' && (expiresAt === null || expiresAt > Date.now())
  return active ? (PLANS.find((id) => id === plan) ?? null) : null
}

export function PlanStep({ state, dispatch }: StepProps): React.JSX.Element {
  const { t } = useT('common')
  const device = useDeviceLabel()
  const email = useAuth().state.email ?? ''
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { plan, cadence } = state.draft.plan

  const finish = (paidPlan: PlanId | null): void => {
    dispatch({ type: 'update', patch: { paidPlan } })
    dispatch({ type: 'next' })
  }

  // Poll while the browser checkout is open; also covers a plan bought earlier.
  useEffect(() => {
    let cancelled = false
    const check = async (): Promise<void> => {
      try {
        const paid = paidPlanOf(await window.api.account.refreshBillingStatus())
        if (!cancelled && paid) finish(paid)
      } catch (err) {
        log.warn('Checking billing status failed', err)
      }
    }
    void check()
    if (!waiting) return () => void (cancelled = true)
    const timer = window.setInterval(() => void check(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
    // finish only dispatches; re-running on its identity would restart polling.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [waiting])

  const checkout = async (): Promise<void> => {
    setError(null)
    try {
      const result = await window.api.account.startCheckout({
        plan,
        cadence: plan === 'believer' ? 'lifetime' : cadence
      })
      if (!result.success) throw new Error(result.error)
      setWaiting(true)
    } catch (err) {
      log.warn('Starting checkout failed', err)
      setError(t(`${K}.checkoutFailed`))
    }
  }

  const setPlan = (next: PlanId): void =>
    dispatch({ type: 'update', patch: { plan: { plan: next, cadence } } })
  const setCadence = (next: PlanCadence): void =>
    dispatch({ type: 'update', patch: { plan: { plan, cadence: next } } })

  if (waiting) {
    const cadenceKey =
      plan === 'believer'
        ? 'cadenceLifetime'
        : cadence === 'annual'
          ? 'cadenceYearly'
          : 'cadenceMonthly'
    return (
      <>
        <StepHeading title={t(`${K}.waitingTitle`)} body={t(`${K}.waitingBody`)} />
        <div className="mt-7 flex w-full max-w-[440px] flex-col rounded-xl bg-surface/50 ring-1 ring-inset ring-border">
          <div className="flex items-center gap-3 px-[18px] py-4">
            <div className="flex grow flex-col gap-0.5">
              <span className="text-[14.5px] font-semibold text-foreground">
                {t(`${K}.selected`, { plan: t(`${K}.${plan}`), cadence: t(`${K}.${cadenceKey}`) })}
              </span>
              <span className="text-[12.5px] text-text-secondary">
                {t(`${K}.billedFor`, { email })}
              </span>
            </div>
            <Button variant="outline" size="sm" onClick={() => setWaiting(false)}>
              {t(`${K}.changePlan`)}
            </Button>
          </div>
          <div
            className="flex items-center gap-2.5 border-t border-border px-[18px] py-3.5 text-[13px] text-text-secondary"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA widget pattern; native tag would change styling or behavior
            role="status"
          >
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
            {t(`${K}.waiting`)}
          </div>
        </div>
        <div className="flex flex-col items-center gap-3.5 pt-6">
          <ContinueButton label={t(`${K}.reopen`)} onClick={() => void checkout()} />
          <QuietLink onClick={() => finish(null)}>{t(`${K}.continueWithout`)}</QuietLink>
          <p className="max-w-[400px] text-center text-xs leading-[17px] text-text-tertiary">
            {t(`${K}.alreadyPaid`)}
          </p>
        </div>
      </>
    )
  }

  return (
    <>
      <StepHeading title={t(`${K}.title`)} body={t(`${K}.body`)} />
      <div
        className="flex gap-0.5 rounded-[9px] bg-surface p-[3px] ring-1 ring-inset ring-border mt-6"
        role="radiogroup"
        aria-label={t(`${K}.title`)}
      >
        {(['monthly', 'annual'] as const).map((option) => (
          <button
            key={option}
            type="button"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA widget pattern; native tag would change styling or behavior
            role="radio"
            aria-checked={cadence === option}
            onClick={() => setCadence(option)}
            className={cn(
              'flex h-[26px] items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              cadence === option ? 'bg-surface-active text-foreground' : 'text-text-secondary'
            )}
          >
            {t(option === 'annual' ? `${K}.yearly` : `${K}.monthly`)}
            {option === 'annual' && (
              <span className="font-semibold text-tint">{t(`${K}.save`)}</span>
            )}
          </button>
        ))}
      </div>
      <OptionList
        role="radiogroup"
        label={t(`${K}.title`)}
        className="w-full max-w-[520px] gap-2.5 pt-4"
      >
        {PLANS.map((id) => {
          const price = PRICES[id]
          const amount =
            'lifetime' in price
              ? price.lifetime
              : cadence === 'annual'
                ? price.annual / 12
                : price.monthly
          return (
            <OptionCard
              key={id}
              kind="radio"
              selected={plan === id}
              onSelect={() => setPlan(id)}
              title={t(`${K}.${id}`)}
              badge={BADGE[id] && t(`${K}.${BADGE[id]}`)}
              description={t(`${K}.${id}Hint`)}
              trailing={
                <span className="flex flex-col items-end gap-0.5">
                  <span className="text-[14.5px] font-semibold text-foreground">
                    {t(`${K}.price`, { amount })}
                    <span className="text-xs font-normal text-text-secondary">
                      {'lifetime' in price ? ` ${t(`${K}.once`)}` : t(`${K}.perMonth`)}
                    </span>
                  </span>
                  <span className="text-[11.5px] text-text-secondary">
                    {'lifetime' in price
                      ? t(`${K}.lifetime`)
                      : cadence === 'annual'
                        ? t(`${K}.billedYearly`, { amount: price.annual })
                        : t(`${K}.billedMonthly`)}
                  </span>
                </span>
              }
            />
          )
        })}
      </OptionList>
      <div className="flex flex-col items-center gap-3.5 pt-6">
        <ContinueButton label={t(`${K}.continue`)} onClick={() => void checkout()} />
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <p className="flex items-center gap-1.5 text-xs text-text-secondary">
          <Lock className="size-3" />
          {t(`${K}.secure`)}
        </p>
        <QuietLink onClick={() => finish(null)}>{t(`${K}.notNow`, { device })}</QuietLink>
      </div>
    </>
  )
}
