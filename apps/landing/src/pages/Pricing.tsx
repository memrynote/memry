import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Check, ArrowRight, ShieldCheck, ExternalLink } from 'lucide-react'
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
  CHECKOUT_RELEASE_TIMING,
  type CheckoutPlanId,
  type PlanComparisonValue,
  type SyncPlanTier,
  type LifecycleTone
} from '@/lib/constants'
import {
  buildMemryBillingCompleteUrl,
  buildMemryBillingStartUrl,
  type PaddleCheckoutCadence
} from '@/lib/paddle-checkout'
import { cn } from '@/lib/utils'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'
import { trackLandingEvent } from '@/lib/analytics'

type Cadence = 'monthly' | 'annual'
type CheckoutState = {
  pendingKey: string | null
  error: string | null
  notice: CheckoutNotice | null
}
type CheckoutNotice =
  | { type: 'success'; transactionId: string | null }
  | { type: 'pending'; transactionId: string | null }
  | { type: 'failed' }
  | { type: 'canceled' }
  | { type: 'desktop'; url: string }

const PURCHASES_ENABLED = true

const fadeUp = {
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.8, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }
}

const ASSURANCES = ['Cancel anytime', 'VAT handled by Paddle', 'Prices in USD']

export function PricingPage() {
  const [cadence, setCadence] = useState<Cadence>('annual')
  const [checkout, setCheckout] = useState<CheckoutState>(() => {
    if (typeof window === 'undefined') {
      return { pendingKey: null, error: null, notice: null }
    }
    const params = new URLSearchParams(window.location.search)
    if (params.get('checkout') === 'success') {
      return {
        pendingKey: null,
        error: null,
        notice: { type: 'success', transactionId: params.get('transactionId') }
      }
    }
    return { pendingKey: null, error: null, notice: null }
  })

  const handleCheckout = async (tier: SyncPlanTier) => {
    if (!PURCHASES_ENABLED || !tier.checkoutPlanId) return

    const checkoutCadence = getCheckoutCadence(tier, cadence)
    const pendingKey = getCheckoutKey(tier.checkoutPlanId, checkoutCadence)
    const desktopUrl = buildMemryBillingStartUrl(tier.checkoutPlanId, checkoutCadence)

    trackLandingEvent('landing_pricing_cta_click', pricingTarget(tier.id, checkoutCadence))
    setCheckout({ pendingKey, error: null, notice: { type: 'desktop', url: desktopUrl } })
    window.location.href = desktopUrl
    window.setTimeout(() => {
      setCheckout((current) =>
        current.pendingKey === pendingKey ? { ...current, pendingKey: null } : current
      )
    }, 1000)
  }

  return (
    <>
      <PageHead page="pricing" />
      <main>
        <Hero />
        <CheckoutNoticeBanner notice={checkout.notice} />
        <TierGrid
          cadence={cadence}
          setCadence={setCadence}
          checkout={checkout}
          onCheckout={handleCheckout}
        />
        <LimitMatrix cadence={cadence} onCheckout={handleCheckout} />
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

function CheckoutNoticeBanner({ notice }: { notice: CheckoutNotice | null }) {
  if (!notice) return null

  const tone =
    notice.type === 'failed'
      ? 'border-terracotta/40 text-terracotta'
      : notice.type === 'canceled'
        ? 'border-amber-500/40 text-amber-700'
        : 'border-sage/40 text-sage'

  const title =
    notice.type === 'success'
      ? 'Purchase complete'
      : notice.type === 'pending'
        ? 'Activation pending'
        : notice.type === 'failed'
          ? 'Payment failed'
          : notice.type === 'canceled'
            ? 'Checkout canceled'
            : 'Open Memry to continue'

  const body =
    notice.type === 'success'
      ? 'Memry will activate hosted sync after Paddle confirms the transaction.'
      : notice.type === 'pending'
        ? 'Paddle is confirming the purchase. If Memry is open, refresh billing in Account.'
        : notice.type === 'failed'
          ? 'The payment was not completed. You can try again from Memry when ready.'
          : notice.type === 'canceled'
            ? 'No charge was made. Start again from Memry when you are ready.'
            : 'Memry desktop signs the checkout request so the purchase lands on your account.'

  const transactionId =
    notice.type === 'success' || notice.type === 'pending' ? notice.transactionId : null
  const openMemryUrl = transactionId ? buildMemryBillingCompleteUrl(transactionId) : 'memry://'

  return (
    <section className="pb-8">
      <Container size="md">
        <div
          className={cn(
            'flex flex-col gap-4 rounded-sm border-2 border-dashed bg-paper px-5 py-4 text-sm sm:flex-row sm:items-center sm:justify-between',
            tone
          )}
          role={notice.type === 'failed' ? 'alert' : 'status'}
        >
          <div>
            <p className="font-mono-accent text-[11px] uppercase tracking-[0.18em]">{title}</p>
            <p className="mt-1 text-ink/75">{body}</p>
          </div>
          {(notice.type === 'success' ||
            notice.type === 'pending' ||
            notice.type === 'desktop') && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 rounded-sm border-ink/20 bg-transparent text-ink hover:bg-paper-alt"
              asChild
            >
              <a href={notice.type === 'desktop' ? notice.url : openMemryUrl}>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                Open Memry
              </a>
            </Button>
          )}
        </div>
      </Container>
    </section>
  )
}

function Hero() {
  return (
    <section className="overflow-hidden pt-28 pb-10 md:pt-36 md:pb-14">
      <Container size="md">
        <motion.div
          initial={BLUR_REVEAL_INITIAL}
          animate={BLUR_REVEAL_ANIMATE}
          transition={BLUR_REVEAL_TRANSITION}
        >
          <div className="text-center">
            <h1 className="mx-auto max-w-3xl font-serif text-5xl leading-[1.05] text-ink text-balance md:text-6xl">
              Sync that respects
              <br />
              your <span className="italic text-terracotta">wallet.</span>
            </h1>
            <p className="mx-auto mt-7 max-w-lg text-base leading-relaxed text-muted md:text-lg">
              Your private productivity OS stays free on your device. Paid sync keeps it safely
              available everywhere — end-to-end encrypted before a single byte leaves.
            </p>
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
      className="inline-flex items-stretch overflow-hidden rounded-sm border border-ink/25"
    >
      {(['monthly', 'annual'] as Cadence[]).map((option, i) => {
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
              'relative inline-flex items-center gap-2 px-5 py-2.5 font-mono-accent text-[11px] uppercase tracking-[0.18em] transition-colors duration-300',
              i > 0 && 'border-s border-ink/25',
              active ? 'bg-ink text-paper' : 'bg-transparent text-muted hover:text-ink'
            )}
          >
            {option}
            {option === 'annual' && (
              <span className={cn(active ? 'text-terracotta-glow' : 'text-terracotta')}>−20%</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function TierGrid({
  cadence,
  setCadence,
  checkout,
  onCheckout
}: {
  cadence: Cadence
  setCadence: (c: Cadence) => void
  checkout: CheckoutState
  onCheckout: (tier: SyncPlanTier) => void
}) {
  return (
    <section className="pb-24">
      <Container>
        <motion.div
          initial={BLUR_REVEAL_INITIAL}
          whileInView={BLUR_REVEAL_ANIMATE}
          viewport={{ once: true, margin: '-80px' }}
          transition={BLUR_REVEAL_TRANSITION}
          className="mb-12 flex flex-col gap-8 md:flex-row md:items-end md:justify-between"
        >
          <div className="max-w-xl">
            <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
              § 01 — The tariff
            </p>
            <h2 className="display-section mt-4 text-ink">
              Choose your <span className="italic text-terracotta">edition.</span>
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-muted">
              Four plans, printed plainly. Start free — upgrade the day you want your vault on a
              second device.
            </p>
          </div>
          <div className="shrink-0">
            <CadenceToggle cadence={cadence} setCadence={setCadence} />
          </div>
        </motion.div>

        <motion.div
          initial={BLUR_REVEAL_INITIAL}
          whileInView={BLUR_REVEAL_ANIMATE}
          viewport={{ once: true, margin: '-80px' }}
          transition={BLUR_REVEAL_TRANSITION}
        >
          <div className="rule-double text-ink/30" aria-hidden />
          <div className="grid md:grid-cols-2 xl:grid-cols-4">
            {SYNC_PLAN_TIERS.map((tier) => (
              <div
                key={tier.id}
                className={cn(
                  'border-ink/10 border-t first:border-t-0',
                  'md:[&:nth-child(2)]:border-t-0 md:odd:border-e',
                  'xl:border-t-0 xl:border-s xl:first:border-s-0 xl:odd:border-e-0',
                  tier.emphasis === 'founding' && 'xl:border-s-0'
                )}
              >
                <TierCard
                  tier={tier}
                  cadence={cadence}
                  isPending={
                    PURCHASES_ENABLED &&
                    !!tier.checkoutPlanId &&
                    checkout.pendingKey ===
                      getCheckoutKey(tier.checkoutPlanId, getCheckoutCadence(tier, cadence))
                  }
                  onCheckout={() => onCheckout(tier)}
                />
              </div>
            ))}
          </div>
          <div className="rule-double text-ink/30" aria-hidden />
        </motion.div>

        {checkout.error && (
          <p
            role="alert"
            className="mx-auto mt-6 max-w-xl rounded-sm border-2 border-dashed border-terracotta/40 px-5 py-3 text-center text-sm text-terracotta"
          >
            {checkout.error}
          </p>
        )}

        <p className="mt-8 text-center font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted/70">
          {ASSURANCES.map((item, i) => (
            <span key={item} className="inline-block">
              {item}
              {i < ASSURANCES.length - 1 && (
                <span aria-hidden className="mx-3 text-terracotta">
                  ✳
                </span>
              )}
            </span>
          ))}
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
  const isCheckoutEnabled = PURCHASES_ENABLED && !!tier.checkoutPlanId
  const isCheckoutUnavailable = !PURCHASES_ENABLED && !!tier.checkoutPlanId
  const ctaLabel = isPending ? 'Opening checkout...' : tier.cta

  const ctaClass = isRecommended
    ? 'w-full rounded-sm bg-terracotta text-white hover:bg-terracotta-dark'
    : isFounding
      ? 'w-full rounded-sm border-ink-inverted/30 bg-transparent text-ink-inverted hover:bg-ink-inverted/10'
      : 'w-full rounded-sm border-ink/20 bg-transparent text-ink hover:bg-paper-alt'

  return (
    <article
      className={cn(
        'relative flex h-full flex-col p-7 sm:p-8',
        isFounding && 'zone-dark',
        isRecommended && 'bg-terracotta/[0.04]'
      )}
    >
      {isRecommended && (
        <div className="absolute inset-x-0 top-0 h-[3px] bg-terracotta" aria-hidden />
      )}
      {isFounding && tier.ribbon && (
        <span className="ink-stamp absolute end-5 top-5 -rotate-3 text-[10px]">{tier.ribbon}</span>
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
            'mt-2 max-w-[28ch] font-serif text-base italic leading-relaxed',
            isFounding ? 'text-dark-muted' : 'text-muted'
          )}
        >
          {tier.tagline}
        </p>
      </header>

      <div className="mt-7">
        <PriceBlock tier={tier} cadence={cadence} isFounding={isFounding} />
      </div>

      <div
        className={cn('mt-7 h-px', isFounding ? 'bg-ink-inverted/15' : 'bg-ink/10')}
        aria-hidden
      />

      <ul className="mt-6 space-y-2.5">
        {tier.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2.5 text-sm">
            <Check
              className={cn(
                'mt-1 h-3.5 w-3.5 shrink-0',
                isFounding ? 'text-terracotta' : 'text-sage'
              )}
              strokeWidth={2.5}
              aria-hidden
            />
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
            aria-label={`${tier.cta} ${CHECKOUT_RELEASE_TIMING.toLowerCase()}`}
            className={ctaClass}
          >
            {CHECKOUT_RELEASE_TIMING}
          </Button>
        ) : !isCheckoutEnabled ? (
          <Button variant="outline" size="lg" className={ctaClass} asChild>
            <Link
              to="/download/desktop"
              onClick={() =>
                trackLandingEvent('landing_pricing_cta_click', pricingTarget(tier.id, cadence))
              }
            >
              {tier.cta}
            </Link>
          </Button>
        ) : (
          <Button
            variant={isRecommended ? 'default' : 'outline'}
            size="lg"
            disabled={isPending}
            onClick={onCheckout}
            aria-label={ctaLabel}
            className={ctaClass}
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
        <div className="flex items-baseline gap-2.5">
          <span className="font-serif text-5xl font-normal leading-none text-ink">$0</span>
          <span className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
            forever
          </span>
        </div>
        <p className="mt-3 font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted/80">
          No account required
        </p>
      </div>
    )
  }

  if (tier.lifetimePrice !== null) {
    return (
      <div>
        <div className="flex items-baseline gap-2.5">
          <span className="font-serif text-5xl font-normal leading-none text-ink-inverted">
            ${tier.lifetimePrice}
          </span>
          <span className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-dark-muted">
            paid once
          </span>
        </div>
        <p className="mt-3 font-mono-accent text-[11px] uppercase tracking-[0.18em] text-terracotta">
          Lifetime · no expiry · future features included
        </p>
      </div>
    )
  }

  const showAnnual = cadence === 'annual'
  const displayPrice = showAnnual ? tier.annualMonthlyEquivalent : tier.monthlyPrice

  return (
    <div>
      <div className="flex items-baseline gap-2.5">
        <span
          className={cn(
            'font-serif text-5xl font-normal leading-none',
            isFounding ? 'text-ink-inverted' : 'text-ink'
          )}
        >
          ${displayPrice}
        </span>
        <span className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
          / month
        </span>
      </div>
      <p
        className={cn(
          'mt-3 font-mono-accent text-[11px] uppercase tracking-[0.18em]',
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
              <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
                § 03 — The patron
              </p>
              <h2 className="display-section text-ink-inverted">
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
              className="relative border border-dark-border bg-dark-surface p-8 md:p-10"
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
        <motion.div {...fadeUp} className="max-w-2xl">
          <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
            § 04 — The lapse
          </p>
          <h2 className="display-section mt-4 text-ink">
            What happens if you <span className="italic text-terracotta">stop paying?</span>
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-muted">
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
          className="mt-14 flex flex-col items-center gap-4 rounded-sm border-2 border-dashed border-terracotta/30 px-6 py-5 text-center md:flex-row md:justify-center md:text-start"
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

function LimitMatrix({
  cadence,
  onCheckout
}: {
  cadence: Cadence
  onCheckout: (tier: SyncPlanTier) => void
}) {
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
        <motion.div {...fadeUp} className="max-w-2xl">
          <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
            § 02 — The full ledger
          </p>
          <h2 className="display-section mt-4 text-ink">
            Every limit, <span className="italic text-terracotta">printed plainly.</span>
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-muted">
            Local features stay free. Paid sync, storage, optional AI access, and supporter extras
            are split out plainly before checkout.
          </p>
        </motion.div>

        <motion.div
          {...fadeUp}
          transition={{ ...fadeUp.transition, delay: 0.1 }}
          className="mt-12 overflow-x-auto"
        >
          <div className="min-w-[940px]">
            <div className="rule-double text-ink/30" aria-hidden />
            <table className="w-full">
              <thead>
                <tr className="border-b border-ink/15">
                  <th className="min-w-[240px] px-6 py-5 text-start font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
                    Feature
                  </th>
                  {plans.map(({ tier }) => {
                    const isRecommended = tier.emphasis === 'recommended'
                    const isFounding = tier.emphasis === 'founding'

                    return (
                      <th
                        key={tier.id}
                        className={cn(
                          'min-w-[170px] px-5 py-5 text-center align-top',
                          isRecommended && 'bg-terracotta/[0.05]',
                          isFounding && 'bg-ink/[0.03]'
                        )}
                      >
                        <div className="flex min-h-[104px] flex-col items-center justify-between gap-3">
                          <div>
                            <span
                              className={cn(
                                'font-serif text-2xl font-normal normal-case tracking-normal',
                                isRecommended ? 'italic text-terracotta' : 'text-ink'
                              )}
                            >
                              {tier.name}
                            </span>
                          </div>
                          {!tier.checkoutPlanId ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 rounded-sm border-ink/20 bg-transparent px-3 text-xs"
                              asChild
                            >
                              <Link
                                to="/download/desktop"
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
                              disabled={!PURCHASES_ENABLED}
                              onClick={() => onCheckout(tier)}
                              className={cn(
                                'h-8 rounded-sm px-3 text-xs',
                                !isRecommended && 'border-ink/20 bg-transparent'
                              )}
                            >
                              {PURCHASES_ENABLED ? tier.cta : CHECKOUT_RELEASE_TIMING}
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
                        className="border-b border-ink/15 px-6 pb-3 pt-8 text-start font-mono-accent text-[11px] uppercase tracking-[0.2em] text-terracotta"
                      >
                        {section.title}
                      </th>
                    </tr>
                    {section.rows.map((row) => (
                      <tr
                        key={row.feature}
                        className="border-b border-ink/10 transition-colors hover:bg-paper-alt/60"
                      >
                        <td className="px-6 py-4 font-serif text-base text-ink">{row.feature}</td>
                        {plans.map(({ planId, tier }) => (
                          <td
                            key={tier.id}
                            className={cn(
                              'px-5 py-4 text-center font-mono-accent text-sm text-ink/80',
                              tier.emphasis === 'recommended' && 'bg-terracotta/[0.04] text-ink',
                              tier.emphasis === 'founding' && 'bg-ink/[0.02]'
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
            <div className="rule-double text-ink/30" aria-hidden />
          </div>
        </motion.div>
      </Container>
    </section>
  )
}

function ComparisonValue({ value }: { value: PlanComparisonValue }) {
  if (value === true) {
    return <Check className="inline h-4 w-4 text-sage" strokeWidth={2.5} aria-label="Included" />
  }

  if (value === false) {
    return <span className="text-muted/45">—</span>
  }

  return <span>{value}</span>
}

function PricingFaq() {
  return (
    <section className="border-t border-border/40 py-24">
      <Container size="md">
        <div className="grid gap-12 lg:grid-cols-[minmax(220px,1fr)_2fr]">
          <motion.div {...fadeUp} className="lg:sticky lg:top-28 lg:self-start">
            <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
              § 05 — Appendix
            </p>
            <h2 className="display-section mt-4 text-ink">
              The honest <span className="italic text-terracotta">billing answers.</span>
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-muted">
              Everything you need to know before checkout opens.
            </p>
          </motion.div>

          <motion.div {...fadeUp}>
            <Accordion type="single" collapsible className="w-full">
              {PRICING_FAQ_ITEMS.map((item, i) => (
                <AccordionItem
                  key={item.question}
                  value={`pricing-faq-${i}`}
                  className="rounded-none border-b border-border/60 bg-transparent px-0 last:border-0 data-[state=open]:bg-transparent"
                >
                  <AccordionTrigger className="py-5 text-start font-serif text-lg text-ink hover:text-terracotta hover:no-underline">
                    <span className="flex items-baseline gap-4">
                      <span className="font-mono-accent text-[11px] tracking-[0.14em] text-muted/50">
                        Q.{String(i + 1).padStart(2, '0')}
                      </span>
                      {item.question}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="max-w-[90%] pb-5 font-sans text-[17px] leading-relaxed text-muted">
                    {item.answer}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </motion.div>
        </div>
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
          <p aria-hidden className="mb-8 font-serif text-2xl tracking-[0.5em] text-terracotta">
            ⁂
          </p>
          <h2 className="display-section mx-auto max-w-2xl text-ink text-balance">
            Local-first is free.{' '}
            <span className="italic text-terracotta">Sync when you need it.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-muted leading-relaxed">
            Start in the free local app. Upgrade the day you want your notes on a second device —
            not a moment sooner.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" className="rounded-sm px-8" asChild>
              <Link to="/download/desktop">
                Download
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="ghost"
              className="rounded-sm px-8 text-ink hover:bg-paper-alt"
              asChild
            >
              <Link to="/security">
                Read the security architecture
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>

          <p className="mt-16 font-mono-accent text-[10px] uppercase tracking-[0.3em] text-muted/50">
            All prices USD · Paddle is the merchant of record ·{' '}
            <span className="italic normal-case">fin.</span>
          </p>
        </motion.div>
      </Container>
    </section>
  )
}
