import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Check, ArrowRight, Sparkles, ShieldCheck, Heart } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { Button } from '@/components/ui/button'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import {
  SYNC_PLAN_TIERS,
  PLAN_COMPARISON_MATRIX,
  LIFECYCLE_STAGES,
  PRICING_FAQ_ITEMS,
  type CheckoutPlanId,
  type PlanComparisonValue,
  type SyncPlanTier,
  type LifecycleTone
} from '@/lib/constants'
import { openPaddleCheckout, type PaddleCheckoutCadence } from '@/lib/paddle-checkout'
import { cn } from '@/lib/utils'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'
import { trackLandingEvent } from '@/lib/analytics'

type Cadence = 'monthly' | 'annual'
type CheckoutState = {
  pendingKey: string | null
  error: string | null
}

const fadeUp = {
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.8, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }
}

export function PricingPage() {
  const [cadence, setCadence] = useState<Cadence>('annual')
  const [checkout, setCheckout] = useState<CheckoutState>({ pendingKey: null, error: null })

  const handleCheckout = async (tier: SyncPlanTier) => {
    if (!tier.checkoutPlanId) return

    const checkoutCadence = getCheckoutCadence(tier, cadence)
    const pendingKey = getCheckoutKey(tier.checkoutPlanId, checkoutCadence)

    trackLandingEvent('landing_pricing_cta_click', pricingTarget(tier.id, checkoutCadence))
    setCheckout({ pendingKey, error: null })
    try {
      await openPaddleCheckout(tier.checkoutPlanId, checkoutCadence)
      setCheckout({ pendingKey: null, error: null })
    } catch (error) {
      setCheckout({
        pendingKey: null,
        error: error instanceof Error ? error.message : 'Could not start checkout'
      })
    }
  }

  return (
    <>
      <PageHead page="pricing" />
      <main>
        <Hero cadence={cadence} setCadence={setCadence} />
        <TierGrid cadence={cadence} checkout={checkout} onCheckout={handleCheckout} />
        <LimitMatrix cadence={cadence} />
        <BelieverNarrative />
        <LifecycleTimeline />
        <PricingFaq />
        <FinalCta />
      </main>
    </>
  )
}

function getCheckoutCadence(tier: SyncPlanTier, cadence: Cadence): PaddleCheckoutCadence {
  return tier.id === 'believer' ? 'lifetime' : cadence
}

function getCheckoutKey(planId: CheckoutPlanId, cadence: PaddleCheckoutCadence) {
  return `${planId}:${cadence}`
}

function pricingTarget(tierId: string, cadence: string) {
  return `pricing:${tierId}:${cadence}`
}

function Hero({ cadence, setCadence }: { cadence: Cadence; setCadence: (c: Cadence) => void }) {
  return (
    <section className="relative overflow-hidden pt-32 pb-8 sm:pb-10 md:pt-40">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[360px] bg-[radial-gradient(ellipse_at_top,rgba(255,103,26,0.10),transparent_60%)]"
      />
      <Container size="md">
        <motion.div
          initial={BLUR_REVEAL_INITIAL}
          animate={BLUR_REVEAL_ANIMATE}
          transition={BLUR_REVEAL_TRANSITION}
          className="text-center"
        >
          <h1 className="font-serif text-4xl font-normal leading-[1.05] text-ink text-balance md:text-5xl">
            Sync that respects
            <br />
            your <span className="italic text-terracotta">wallet.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-lg text-base leading-relaxed text-muted text-balance md:text-lg">
            The local app stays free, forever. Sync is paid — fair, predictable, and end-to-end
            encrypted before a single byte leaves your device.
          </p>

          <div className="mt-7 flex justify-center">
            <CadenceToggle cadence={cadence} setCadence={setCadence} />
          </div>
        </motion.div>
      </Container>
    </section>
  )
}

function CadenceToggle({
  cadence,
  setCadence
}: {
  cadence: Cadence
  setCadence: (c: Cadence) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Billing cadence"
      className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card/65 p-1 shadow-[0_2px_18px_rgba(26,26,26,0.04)] backdrop-blur dark:shadow-none"
    >
      {(['monthly', 'annual'] as Cadence[]).map((option) => {
        const active = cadence === option
        return (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              trackLandingEvent('landing_pricing_cadence_change', `pricing-cadence:${option}`)
              setCadence(option)
            }}
            className={cn(
              'relative inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-all duration-300',
              active
                ? 'bg-ink text-paper shadow-[0_4px_14px_rgba(26,26,26,0.18)]'
                : 'text-muted hover:text-ink'
            )}
          >
            <span className="capitalize">{option}</span>
            {option === 'annual' && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 font-mono-accent text-[10px] uppercase tracking-widest transition-colors',
                  active ? 'bg-terracotta/30 text-paper' : 'bg-terracotta/15 text-terracotta'
                )}
              >
                –20%
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function TierGrid({
  cadence,
  checkout,
  onCheckout
}: {
  cadence: Cadence
  checkout: CheckoutState
  onCheckout: (tier: SyncPlanTier) => void
}) {
  return (
    <section className="pb-24">
      <Container size="lg">
        <motion.div
          initial={BLUR_REVEAL_INITIAL}
          whileInView={BLUR_REVEAL_ANIMATE}
          viewport={{ once: true, margin: '-80px' }}
          transition={BLUR_REVEAL_TRANSITION}
          className="mb-10 text-center"
        >
          <span className="font-mono-accent text-[11px] uppercase tracking-[0.28em] text-muted">
            Plans
          </span>
          <h2 className="mt-3 font-serif text-4xl font-normal leading-tight text-ink md:text-5xl">
            Choose your memrynote plan
          </h2>
        </motion.div>
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4 xl:items-stretch xl:gap-5">
          {SYNC_PLAN_TIERS.map((tier) => (
            <motion.div
              key={tier.id}
              initial={BLUR_REVEAL_INITIAL}
              whileInView={BLUR_REVEAL_ANIMATE}
              viewport={{ once: true, margin: '-80px' }}
              transition={BLUR_REVEAL_TRANSITION}
              className="h-full"
            >
              <TierCard
                tier={tier}
                cadence={cadence}
                isPending={
                  !!tier.checkoutPlanId &&
                  checkout.pendingKey ===
                    getCheckoutKey(tier.checkoutPlanId, getCheckoutCadence(tier, cadence))
                }
                onCheckout={() => onCheckout(tier)}
              />
            </motion.div>
          ))}
        </div>
        {checkout.error && (
          <p
            role="alert"
            className="mx-auto mt-6 max-w-xl rounded-2xl border border-terracotta/25 bg-terracotta/5 px-5 py-3 text-center text-sm text-terracotta"
          >
            {checkout.error}
          </p>
        )}
        <p className="mt-10 text-center font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted/70">
          All prices in USD &nbsp;·&nbsp; VAT and sales tax handled at checkout
        </p>
      </Container>
    </section>
  )
}

function TierCard({
  tier,
  cadence,
  isPending,
  onCheckout
}: {
  tier: SyncPlanTier
  cadence: Cadence
  isPending: boolean
  onCheckout: () => void
}) {
  const isFounding = tier.emphasis === 'founding'
  const isRecommended = tier.emphasis === 'recommended'
  const isCheckoutEnabled = !!tier.checkoutPlanId
  const isCheckoutUnavailable = isCheckoutEnabled
  const ctaLabel = isPending ? 'Opening checkout...' : tier.cta

  return (
    <article
      className={cn(
        'relative flex h-full flex-col overflow-hidden rounded-[28px] border p-7 transition-all duration-300 sm:p-8',
        isFounding
          ? 'border-dark-border bg-dark text-ink-inverted shadow-[0_24px_60px_-30px_rgba(20,18,16,0.55)]'
          : isRecommended
            ? 'border-terracotta/35 bg-card shadow-[0_20px_60px_-32px_rgba(255,103,26,0.45)] lg:scale-[1.015]'
            : 'border-border/60 bg-card shadow-card'
      )}
    >
      {tier.ribbon && (
        <span
          className={cn(
            'absolute right-6 top-6 inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-mono-accent text-[10px] uppercase tracking-[0.2em]',
            isFounding
              ? 'bg-terracotta/15 text-terracotta'
              : 'bg-terracotta text-paper shadow-[0_8px_22px_-8px_rgba(255,103,26,0.6)]'
          )}
        >
          {isFounding ? <Heart className="h-3 w-3" aria-hidden /> : null}
          {tier.ribbon}
        </span>
      )}

      <header>
        <h3
          className={cn(
            'font-serif text-3xl font-normal',
            isFounding ? 'text-ink-inverted' : 'text-ink'
          )}
        >
          {tier.name}
        </h3>
        <p
          className={cn(
            'mt-2 max-w-[28ch] text-sm leading-relaxed',
            isFounding ? 'text-dark-muted' : 'text-muted'
          )}
        >
          {tier.tagline}
        </p>
      </header>

      <div className="mt-7">
        <PriceBlock tier={tier} cadence={cadence} isFounding={isFounding} />
      </div>

      <ul className="mt-7 space-y-3">
        {tier.features.map((feature) => (
          <li key={feature} className="flex items-start gap-3 text-sm">
            <span
              className={cn(
                'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                isFounding
                  ? 'border-terracotta/40 bg-terracotta/10 text-terracotta'
                  : 'border-sage/35 bg-sage/10 text-sage'
              )}
            >
              <Check className="h-3 w-3" strokeWidth={3} />
            </span>
            <span
              className={cn('leading-relaxed', isFounding ? 'text-ink-inverted/85' : 'text-ink/80')}
            >
              {feature}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-auto pt-8">
        {isCheckoutUnavailable ? (
          <Button
            variant={isRecommended ? 'default' : 'outline'}
            size="lg"
            disabled
            aria-label={`${tier.cta} coming soon`}
            className={cn(
              'w-full rounded-full',
              isRecommended
                ? 'bg-terracotta text-white shadow-[0_16px_34px_-14px_rgba(255,103,26,0.75)] ring-2 ring-terracotta/20'
                : 'border-ink/15 bg-paper-alt/40 text-ink'
            )}
          >
            Coming soon
          </Button>
        ) : !isCheckoutEnabled ? (
          <Button
            variant="outline"
            size="lg"
            className="w-full rounded-full border-ink/15 bg-paper-alt/40 text-ink hover:bg-paper-alt"
            asChild
          >
            <Link
              to="/#waitlist"
              onClick={() =>
                trackLandingEvent('landing_pricing_cta_click', pricingTarget(tier.id, cadence))
              }
            >
              {tier.cta}
            </Link>
          </Button>
        ) : isFounding ? (
          <Button
            variant="outline"
            size="lg"
            disabled={isPending}
            onClick={onCheckout}
            aria-label={ctaLabel}
            className="w-full rounded-full border-ink/15 bg-paper-alt/40 text-ink hover:bg-paper-alt"
          >
            {ctaLabel}
          </Button>
        ) : isRecommended ? (
          <Button
            variant="default"
            size="lg"
            disabled={isPending}
            onClick={onCheckout}
            aria-label={ctaLabel}
            className="w-full rounded-full bg-terracotta text-white shadow-[0_16px_34px_-14px_rgba(255,103,26,0.75)] ring-2 ring-terracotta/20 hover:bg-terracotta-dark hover:shadow-[0_18px_38px_-14px_rgba(255,103,26,0.9)]"
          >
            {ctaLabel}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="lg"
            disabled={isPending}
            onClick={onCheckout}
            aria-label={ctaLabel}
            className="w-full rounded-full border-ink/15 bg-paper-alt/40 text-ink hover:bg-paper-alt"
          >
            {ctaLabel}
          </Button>
        )}
      </div>
    </article>
  )
}

function PriceBlock({
  tier,
  cadence,
  isFounding
}: {
  tier: SyncPlanTier
  cadence: Cadence
  isFounding: boolean
}) {
  if (tier.id === 'free') {
    return (
      <div>
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              'font-mono-accent text-5xl font-medium leading-none transition-colors',
              isFounding ? 'text-ink-inverted' : 'text-ink'
            )}
          >
            $0
          </span>
          <span className={cn('font-sans text-sm', isFounding ? 'text-dark-muted' : 'text-muted')}>
            forever
          </span>
        </div>
        <p className="mt-2 font-mono-accent text-xs uppercase tracking-[0.18em] text-muted/80">
          No account required
        </p>
      </div>
    )
  }

  if (tier.lifetimePrice !== null) {
    return (
      <div>
        <div className="flex items-baseline gap-2">
          <span className="font-mono-accent text-5xl font-medium text-ink-inverted leading-none">
            ${tier.lifetimePrice}
          </span>
          <span className="font-sans text-sm uppercase tracking-widest text-dark-muted">
            paid once
          </span>
        </div>
        <p className="mt-2 font-mono-accent text-xs uppercase tracking-[0.18em] text-terracotta">
          Lifetime &nbsp;·&nbsp; no expiry &nbsp;·&nbsp; future features included
        </p>
      </div>
    )
  }

  const showAnnual = cadence === 'annual'
  const displayPrice = showAnnual ? tier.annualMonthlyEquivalent : tier.monthlyPrice

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'font-mono-accent text-5xl font-medium leading-none transition-colors',
            isFounding ? 'text-ink-inverted' : 'text-ink'
          )}
        >
          ${displayPrice}
        </span>
        <span className={cn('font-sans text-sm', isFounding ? 'text-dark-muted' : 'text-muted')}>
          / month
        </span>
      </div>
      <p
        className={cn(
          'mt-2 font-mono-accent text-xs uppercase tracking-[0.18em]',
          showAnnual ? 'text-terracotta' : 'text-muted/80'
        )}
      >
        {showAnnual
          ? `Billed $${tier.annualPrice} yearly · save 20%`
          : `or $${tier.annualPrice} / yr ($${tier.annualMonthlyEquivalent}/mo billed yearly)`}
      </p>
    </div>
  )
}

function BelieverNarrative() {
  return (
    <section className="relative">
      <div className="h-[80px] bg-gradient-to-b from-paper to-dark" aria-hidden />
      <div className="zone-dark py-24 md:py-28">
        <Container size="md">
          <div className="grid gap-12 md:grid-cols-[1fr_1.4fr] md:items-center">
            <motion.div {...fadeUp} className="space-y-6">
              <span className="inline-flex items-center gap-2 rounded-full border border-terracotta/30 bg-terracotta/10 px-3 py-1 font-mono-accent text-[10px] uppercase tracking-[0.22em] text-terracotta">
                <Sparkles className="h-3 w-3" aria-hidden /> Believer
              </span>
              <h2 className="font-serif text-4xl font-normal leading-tight text-ink-inverted md:text-5xl">
                Pay <span className="italic text-terracotta">$500 once.</span>
                <br />
                Keep memrynote independent.
              </h2>
              <p className="text-lg leading-relaxed text-dark-muted">
                Believer is a supporter package: everything in Pro, more encrypted storage,
                unlimited vaults, early access, and a name in the credits.
              </p>
            </motion.div>

            <motion.figure
              {...fadeUp}
              transition={{ ...fadeUp.transition, delay: 0.15 }}
              className="relative rounded-3xl border border-dark-border bg-dark-surface p-8 md:p-10"
            >
              <div
                className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-terracotta/60 to-transparent"
                aria-hidden
              />
              <blockquote className="font-serif text-xl leading-relaxed text-ink-inverted/90 md:text-2xl">
                <span className="font-serif text-4xl text-terracotta leading-none">“</span>
                Indie software lives or dies on the people who back it early. Believers aren&apos;t
                just buying storage — they&apos;re helping keep memrynote independent while we build
                the next ten years.
              </blockquote>
              <figcaption className="mt-6 flex items-center gap-3 text-sm font-mono-accent uppercase tracking-[0.18em] text-dark-muted">
                <span className="h-px w-8 bg-terracotta/60" aria-hidden />
                Kaan, founder
              </figcaption>
            </motion.figure>
          </div>
        </Container>
      </div>
    </section>
  )
}

const TONE_DOT_CLASS: Record<LifecycleTone, string> = {
  sage: 'bg-sage shadow-[0_0_0_5px_rgba(91,127,106,0.15)]',
  amber: 'bg-amber-500 shadow-[0_0_0_5px_rgba(217,119,6,0.18)]',
  terracotta: 'bg-terracotta shadow-[0_0_0_5px_rgba(255,103,26,0.22)]',
  'terracotta-dim': 'bg-terracotta/55 shadow-[0_0_0_5px_rgba(255,103,26,0.12)]',
  ink: 'bg-ink/80 shadow-[0_0_0_5px_rgba(26,26,26,0.12)]'
}

const TONE_TEXT_CLASS: Record<LifecycleTone, string> = {
  sage: 'text-sage',
  amber: 'text-amber-600',
  terracotta: 'text-terracotta',
  'terracotta-dim': 'text-terracotta/75',
  ink: 'text-ink/75'
}

function LifecycleTimeline() {
  return (
    <section className="border-t border-border/40 bg-paper-deep/40 py-24 md:py-28">
      <Container size="md">
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <span className="font-mono-accent text-[11px] uppercase tracking-[0.28em] text-muted">
            Lapse policy
          </span>
          <h2 className="mt-3 font-serif text-4xl font-normal leading-tight text-ink md:text-5xl">
            What happens if you stop paying?
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Sync gets paused, never punished. You get a long, predictable runway to recover — up to
            90 days before encrypted blobs are physically deleted.
          </p>
        </motion.div>

        <div className="mt-16">
          <div className="relative">
            <div
              aria-hidden
              className="absolute left-4 top-2 hidden h-[calc(100%-1.5rem)] w-px bg-gradient-to-b from-sage/60 via-terracotta/40 to-ink/30 md:left-1/2 md:top-1/2 md:hidden md:h-px md:w-[calc(100%-3rem)] md:-translate-y-1/2"
            />
            <div
              aria-hidden
              className="absolute left-0 right-0 top-[22px] hidden h-px bg-gradient-to-r from-sage/50 via-terracotta/40 to-ink/20 md:block"
            />

            <ol className="grid gap-10 md:grid-cols-5 md:gap-4">
              {LIFECYCLE_STAGES.map((stage, i) => (
                <motion.li
                  key={stage.id}
                  {...fadeUp}
                  transition={{ ...fadeUp.transition, delay: i * 0.08 }}
                  className="relative flex flex-col gap-3 md:items-center md:text-center"
                >
                  <div
                    className={cn(
                      'relative z-10 inline-flex h-3 w-3 items-center justify-center rounded-full',
                      TONE_DOT_CLASS[stage.tone]
                    )}
                    aria-hidden
                  />
                  <p
                    className={cn(
                      'font-mono-accent text-[11px] uppercase tracking-[0.18em]',
                      TONE_TEXT_CLASS[stage.tone]
                    )}
                  >
                    {stage.days}
                  </p>
                  <h3 className="font-serif text-xl text-ink leading-tight">{stage.label}</h3>
                  <p className="text-sm leading-relaxed text-muted md:max-w-[20ch]">
                    {stage.description}
                  </p>
                </motion.li>
              ))}
            </ol>
          </div>
        </div>

        <motion.div
          {...fadeUp}
          transition={{ ...fadeUp.transition, delay: 0.4 }}
          className="mt-14 flex flex-col items-center gap-4 rounded-2xl border border-terracotta/25 bg-terracotta/5 px-6 py-5 text-center md:flex-row md:justify-center md:text-left"
        >
          <ShieldCheck className="h-5 w-5 text-terracotta shrink-0" aria-hidden />
          <p className="text-sm leading-relaxed text-ink">
            <span className="font-medium">Local-first fallback.</span> If billing stops, hosted sync
            pauses immediately, but your local vault remains usable.
          </p>
        </motion.div>
      </Container>
    </section>
  )
}

function LimitMatrix({ cadence }: { cadence: Cadence }) {
  const plans = PLAN_COMPARISON_MATRIX.plans.map((planId) => {
    const tier = SYNC_PLAN_TIERS.find((item) => item.id === planId)
    if (!tier) {
      throw new Error(`Missing pricing tier for comparison table: ${planId}`)
    }
    return { planId, tier }
  })

  return (
    <section className="py-24 md:py-28">
      <Container size="md">
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <span className="font-mono-accent text-[11px] uppercase tracking-[0.28em] text-muted">
            The full picture
          </span>
          <h2 className="mt-3 font-serif text-4xl font-normal leading-tight text-ink md:text-5xl">
            Compare plans
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Local features stay free. Paid sync, storage, AI access, and supporter extras are split
            out plainly before checkout.
          </p>
        </motion.div>

        <motion.div
          {...fadeUp}
          transition={{ ...fadeUp.transition, delay: 0.1 }}
          className="mt-12 overflow-x-auto rounded-2xl border border-border/55 bg-card/55 shadow-card"
        >
          <table className="w-full min-w-[940px]">
            <thead>
              <tr className="border-b border-border/60">
                <th className="min-w-[240px] px-6 py-5 text-start font-mono-accent text-[11px] uppercase tracking-[0.18em] text-ink">
                  Compare plans
                </th>
                {plans.map(({ tier }) => {
                  const isRecommended = tier.emphasis === 'recommended'
                  const isFounding = tier.emphasis === 'founding'

                  return (
                    <th
                      key={tier.id}
                      className={cn(
                        'min-w-[170px] px-5 py-5 text-center align-top',
                        isRecommended
                          ? 'border-x border-terracotta/25 bg-terracotta/[0.04] text-terracotta'
                          : 'text-muted',
                        isFounding && 'bg-ink/[0.03]'
                      )}
                    >
                      <div className="flex min-h-[112px] flex-col items-center justify-between gap-3">
                        <div>
                          <span className="font-serif text-2xl font-normal normal-case tracking-normal text-ink">
                            {tier.name}
                          </span>
                          {isRecommended && (
                            <span className="mt-2 inline-flex items-center justify-center gap-2 rounded-full bg-terracotta/10 px-2.5 py-1 font-mono-accent text-[10px] uppercase tracking-[0.18em] text-terracotta">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-terracotta" />
                              Popular
                            </span>
                          )}
                        </div>
                        {!tier.checkoutPlanId ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 rounded-full px-3 text-xs"
                            asChild
                          >
                            <Link
                              to="/#waitlist"
                              onClick={() =>
                                trackLandingEvent(
                                  'landing_pricing_cta_click',
                                  pricingTarget(tier.id, cadence)
                                )
                              }
                            >
                              Get started
                            </Link>
                          </Button>
                        ) : (
                          <Button
                            variant={isRecommended ? 'default' : 'outline'}
                            size="sm"
                            disabled
                            className="h-8 rounded-full px-3 text-xs"
                          >
                            Coming soon
                          </Button>
                        )}
                      </div>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {PLAN_COMPARISON_MATRIX.sections.map((section) => (
                <Fragment key={section.title}>
                  <tr key={`${section.title}-heading`}>
                    <th
                      colSpan={plans.length + 1}
                      className="bg-paper-alt/70 px-6 py-4 text-start font-mono-accent text-[11px] uppercase tracking-[0.2em] text-terracotta"
                    >
                      {section.title}
                    </th>
                  </tr>
                  {section.rows.map((row) => (
                    <tr
                      key={row.feature}
                      className="border-b border-border/40 last:border-0 transition-colors hover:bg-paper-alt/40"
                    >
                      <td className="px-6 py-4 text-sm font-medium text-ink">{row.feature}</td>
                      {plans.map(({ planId, tier }) => (
                        <td
                          key={tier.id}
                          className={cn(
                            'px-5 py-4 text-center font-mono-accent text-sm text-ink/80',
                            tier.emphasis === 'recommended' &&
                              'border-x border-terracotta/15 bg-terracotta/[0.025] text-ink'
                          )}
                        >
                          <ComparisonValue value={row[planId]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </motion.div>
      </Container>
    </section>
  )
}

function ComparisonValue({ value }: { value: PlanComparisonValue }) {
  if (value === true) {
    return (
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-sage/10 text-sage">
        <Check className="h-3.5 w-3.5" strokeWidth={3} aria-label="Included" />
      </span>
    )
  }

  if (value === false) {
    return <span className="text-muted/45">—</span>
  }

  return <span>{value}</span>
}

function PricingFaq() {
  return (
    <section className="border-t border-border/40 bg-paper-alt/35 py-24">
      <Container size="sm">
        <motion.div {...fadeUp} className="mb-12 text-center">
          <span className="font-mono-accent text-[11px] uppercase tracking-[0.28em] text-muted">
            FAQ
          </span>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-4xl">
            The honest billing answers
          </h2>
        </motion.div>

        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }}>
          <Accordion type="single" collapsible className="w-full">
            {PRICING_FAQ_ITEMS.map((item, i) => (
              <AccordionItem
                key={i}
                value={`pricing-faq-${i}`}
                className="rounded-none border-b border-border/55 bg-transparent px-0 last:border-0 data-[state=open]:bg-transparent"
              >
                <AccordionTrigger className="py-5 text-left font-serif text-lg text-ink hover:text-terracotta hover:no-underline">
                  {item.question}
                </AccordionTrigger>
                <AccordionContent className="pb-5 text-[17px] font-sans leading-relaxed text-muted max-w-[92%]">
                  {item.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </motion.div>
      </Container>
    </section>
  )
}

function FinalCta() {
  return (
    <section className="relative overflow-hidden py-28">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(255,103,26,0.10),transparent_55%)]"
      />
      <Container size="md">
        <motion.div {...fadeUp} className="text-center">
          <h2 className="mx-auto max-w-2xl font-serif text-4xl font-normal leading-tight text-ink text-balance md:text-5xl">
            Local-first is free.{' '}
            <span className="italic text-terracotta">Sync when you need it.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-muted leading-relaxed">
            Start in the free local app. Upgrade the day you want your notes on a second device —
            not a moment sooner.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" className="rounded-full px-8" asChild>
              <Link to="/#waitlist">
                Join the waitlist
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="ghost"
              className="rounded-full px-8 text-ink hover:bg-paper-alt"
              asChild
            >
              <Link to="/security">
                Read the security architecture
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </motion.div>
      </Container>
    </section>
  )
}
