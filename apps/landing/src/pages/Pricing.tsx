import { Fragment, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { motion, useReducedMotion } from 'motion/react'
import { Check, ShieldCheck, ExternalLink } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { Faq } from '@/components/site/Faq'
import { FinalCta } from '@/components/site/FinalCta'
import { PageHero } from '@/components/site/PageHero'
import { Button } from '@/components/ui/button'
import {
  SYNC_PLAN_TIERS,
  PLAN_COMPARISON_MATRIX,
  LIFECYCLE_STAGES,
  PRICING_FAQ_ITEMS,
  CHECKOUT_RELEASE_TIMING,
  type PlanComparisonValue,
  type SyncPlanTier,
  type SyncPlanId,
  type LifecycleTone
} from '@/lib/constants'
import { buildMemryBillingCompleteUrl, type PaddleCheckoutCadence } from '@/lib/paddle-checkout'
import { cn } from '@/lib/utils'
import { SITE_TINTS } from '@/lib/site-tints'
import { trackLandingEvent } from '@/lib/analytics'

type Cadence = 'monthly' | 'annual'
type CheckoutState = {
  error: string | null
  notice: CheckoutNotice | null
}
type CheckoutNotice =
  | { type: 'success'; transactionId: string | null }
  | { type: 'pending'; transactionId: string | null }
  | { type: 'failed' }
  | { type: 'canceled' }

const PURCHASES_ENABLED = true

const TIER_EASE = [0.16, 1, 0.3, 1] as const

const fadeUp = {
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.8, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }
}

const ASSURANCES = ['Cancel anytime', 'Tax by location', 'Prices in USD']

export function PricingPage() {
  const navigate = useNavigate()
  const [cadence, setCadence] = useState<Cadence>('annual')
  const [checkout] = useState<CheckoutState>(() => {
    if (typeof window === 'undefined') {
      return { error: null, notice: null }
    }
    const params = new URLSearchParams(window.location.search)
    if (params.get('checkout') === 'success') {
      return {
        error: null,
        notice: { type: 'success', transactionId: params.get('transactionId') }
      }
    }
    return { error: null, notice: null }
  })

  const handleCheckout = (tier: SyncPlanTier) => {
    if (!PURCHASES_ENABLED || !tier.checkoutPlanId) return

    const checkoutCadence = getCheckoutCadence(tier, cadence)
    trackLandingEvent('landing_pricing_cta_click', pricingTarget(tier.id, checkoutCadence))
    const params = new URLSearchParams({ plan: tier.checkoutPlanId, cadence: checkoutCadence })
    navigate(`/checkout?${params.toString()}`)
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
        <Faq
          eyebrow="§ 05 — Appendix"
          title={
            <>
              The honest <span className="italic text-terracotta">billing answers.</span>
            </>
          }
          sub="Everything you need to know before checkout opens."
          items={PRICING_FAQ_ITEMS}
        />
        <FinalCta
          title={
            <>
              Local-first is free.{' '}
              <span className="italic text-terracotta">Sync when you need it.</span>
            </>
          }
          sub="Start in the free local app. Upgrade the day you want your notes on a second device — not a moment sooner."
          location="pricing-final"
          secondary={{
            label: 'Read the security architecture',
            to: '/security',
            event: 'security:pricing-final'
          }}
          footnote={
            <>
              All prices USD · Paddle is the merchant of record ·{' '}
              <span className="italic normal-case">fin.</span>
            </>
          }
        />
      </main>
    </>
  )
}

function getCheckoutCadence(tier: SyncPlanTier, cadence: Cadence): PaddleCheckoutCadence {
  return tier.id === 'believer' ? 'lifetime' : cadence
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
          : 'Checkout canceled'

  const body =
    notice.type === 'success'
      ? 'Memrynote will activate hosted sync after Paddle confirms the transaction.'
      : notice.type === 'pending'
        ? 'Paddle is confirming the purchase. If Memrynote is open, refresh billing in Account.'
        : notice.type === 'failed'
          ? 'The payment was not completed. You can try again from Memrynote when ready.'
          : 'No charge was made. Start again from Memrynote when you are ready.'

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
          {(notice.type === 'success' || notice.type === 'pending') && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 rounded-sm border-ink/20 bg-transparent text-ink hover:bg-paper-alt"
              asChild
            >
              <a href={openMemryUrl}>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                Open Memrynote
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
    <PageHero
      tint={SITE_TINTS.pricing}
      eyebrow="Pricing"
      title={
        <>
          Sync that respects your <span className="italic text-terracotta">wallet.</span>
        </>
      }
      sub="The app is free on your device. Paid sync keeps your vault everywhere — end-to-end encrypted before a single byte leaves."
    />
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
  const reduceMotion = useReducedMotion()

  return (
    <section className="pb-24">
      <Container>
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.15, ease: TIER_EASE }}
          className="mb-8 flex flex-wrap items-end justify-between gap-x-8 gap-y-5"
        >
          <div>
            <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
              § 01 — The tariff
            </p>
            <h2 className="mt-3 font-serif text-3xl text-ink md:text-4xl">
              Choose your <span className="italic text-terracotta">edition.</span>
            </h2>
          </div>
          <CadenceToggle cadence={cadence} setCadence={setCadence} />
        </motion.div>

        <motion.div
          className="rule-double origin-left text-ink/30"
          aria-hidden
          initial={reduceMotion ? false : { scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.8, delay: 0.25, ease: TIER_EASE }}
        />
        <div className="grid md:grid-cols-2 lg:grid-cols-4">
          {SYNC_PLAN_TIERS.map((tier, i) => (
            <motion.div
              key={tier.id}
              initial={reduceMotion ? false : { opacity: 0, y: 18, filter: 'blur(8px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.7, delay: 0.35 + i * 0.08, ease: TIER_EASE }}
              className={cn(
                'border-ink/10',
                'max-md:[&:not(:first-child)]:border-t',
                'md:max-lg:[&:nth-child(n+3)]:border-t md:max-lg:[&:nth-child(even)]:border-s',
                'lg:[&:not(:first-child)]:border-s'
              )}
            >
              <TierCard
                tier={tier}
                index={i}
                cadence={cadence}
                reduceMotion={reduceMotion ?? false}
                onCheckout={() => onCheckout(tier)}
              />
            </motion.div>
          ))}
        </div>
        <motion.div
          className="rule-double origin-left text-ink/30"
          aria-hidden
          initial={reduceMotion ? false : { scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.8, delay: 0.35, ease: TIER_EASE }}
        />

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

/* ponytail: gauge widths are sqrt-ish visual scale, not linear GB — linear would make 1 GB invisible */
const STORAGE_GAUGE: Record<SyncPlanId, { fill: number; label: string }> = {
  free: { fill: 0, label: 'No cloud — 100% local' },
  plus: { fill: 0.37, label: '1 GB encrypted cloud' },
  pro: { fill: 0.74, label: '10 GB encrypted cloud' },
  believer: { fill: 1, label: '50 GB encrypted cloud' }
}

function StorageGauge({
  tier,
  index,
  isFounding,
  reduceMotion
}: {
  tier: SyncPlanTier
  index: number
  isFounding: boolean
  reduceMotion: boolean
}) {
  const gauge = STORAGE_GAUGE[tier.id]

  return (
    <div className="mt-5">
      <div
        className={cn(
          'h-1 overflow-hidden rounded-full',
          gauge.fill === 0
            ? 'border border-dashed border-ink/20 bg-transparent'
            : isFounding
              ? 'bg-ink-inverted/15'
              : 'bg-ink/10'
        )}
        aria-hidden
      >
        {gauge.fill > 0 && (
          <motion.div
            className="h-full origin-left rounded-full bg-terracotta"
            style={{ width: `${gauge.fill * 100}%` }}
            initial={reduceMotion ? false : { scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.7, delay: 0.9 + index * 0.06, ease: TIER_EASE }}
          />
        )}
      </div>
      <p
        className={cn(
          'mt-2 font-mono-accent text-[10px] uppercase tracking-[0.14em]',
          isFounding ? 'text-dark-muted' : 'text-muted'
        )}
      >
        {gauge.label}
      </p>
    </div>
  )
}

function TierCard({
  tier,
  index,
  cadence,
  reduceMotion,
  onCheckout
}: {
  tier: SyncPlanTier
  index: number
  cadence: Cadence
  reduceMotion: boolean
  onCheckout: () => void
}) {
  const isFounding = tier.emphasis === 'founding'
  const isRecommended = tier.emphasis === 'recommended'
  const isStandard = !isFounding && !isRecommended
  const isCheckoutEnabled = PURCHASES_ENABLED && !!tier.checkoutPlanId
  const isCheckoutUnavailable = !PURCHASES_ENABLED && !!tier.checkoutPlanId

  const baseline = tier.features[0]?.startsWith('Everything in') ? tier.features[0] : null
  const features = baseline ? tier.features.slice(1) : tier.features

  const ctaClass = isRecommended
    ? 'w-full rounded-sm bg-terracotta text-white hover:bg-terracotta-dark'
    : isFounding
      ? 'w-full rounded-sm border-ink-inverted/40 bg-transparent text-ink-inverted hover:bg-ink-inverted/10'
      : 'w-full rounded-sm border-ink/20 bg-transparent text-ink hover:bg-paper-alt'

  return (
    <article
      className={cn(
        'relative flex h-full flex-col p-6 transition-colors duration-300 lg:p-7',
        isFounding && 'zone-dark',
        isRecommended && 'bg-terracotta/[0.04]',
        isStandard && 'hover:bg-paper-alt/60'
      )}
    >
      {isRecommended && (
        <>
          <div className="absolute inset-x-0 top-0 h-[3px] bg-terracotta" aria-hidden />
          {tier.ribbon && (
            <motion.span
              className="absolute -top-3 inset-x-0 mx-auto w-fit rounded-sm bg-terracotta px-2.5 py-1 font-mono-accent text-[10px] uppercase tracking-[0.16em] text-white"
              initial={reduceMotion ? false : { opacity: 0, y: 6, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.5, delay: 0.8, ease: TIER_EASE }}
            >
              {tier.ribbon}
            </motion.span>
          )}
        </>
      )}
      {isFounding && tier.ribbon && (
        <span className="ink-stamp absolute -top-3 end-4 -rotate-3 bg-dark text-[10px]">
          {tier.ribbon}
        </span>
      )}

      <header>
        <h3
          className={cn(
            'font-serif text-2xl font-normal lg:text-[1.75rem]',
            isFounding ? 'text-ink-inverted' : 'text-ink'
          )}
        >
          {tier.name}
        </h3>
        <p
          className={cn(
            'mt-1.5 min-h-[2.6em] max-w-[28ch] font-serif text-sm italic leading-snug',
            isFounding ? 'text-dark-muted' : 'text-muted'
          )}
        >
          {tier.tagline}
        </p>
      </header>

      <div className="mt-5">
        <PriceBlock
          tier={tier}
          cadence={cadence}
          isFounding={isFounding}
          reduceMotion={reduceMotion}
        />
      </div>

      <StorageGauge tier={tier} index={index} isFounding={isFounding} reduceMotion={reduceMotion} />

      <div className="mt-6">
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
            onClick={onCheckout}
            aria-label={tier.cta}
            className={ctaClass}
          >
            {tier.cta}
          </Button>
        )}
      </div>

      <div
        className={cn('mt-6 h-px', isFounding ? 'bg-ink-inverted/15' : 'bg-ink/10')}
        aria-hidden
      />

      <ul className="mt-5 space-y-2.5">
        {baseline && (
          <li
            className={cn(
              'font-mono-accent text-[10px] uppercase tracking-[0.14em]',
              isFounding ? 'text-dark-muted' : 'text-muted'
            )}
          >
            {baseline}, plus —
          </li>
        )}
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-2.5 text-[13px]">
            <Check
              className={cn(
                'mt-0.5 h-3.5 w-3.5 shrink-0',
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
    </article>
  )
}

function PriceBlock({
  tier,
  cadence,
  isFounding,
  reduceMotion
}: {
  tier: SyncPlanTier
  cadence: Cadence
  isFounding: boolean
  reduceMotion: boolean
}) {
  if (tier.id === 'free') {
    return (
      <div>
        <div className="flex items-baseline gap-2.5">
          <span className="font-serif text-4xl font-normal leading-none text-ink lg:text-5xl">
            $0
          </span>
          <span className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
            forever
          </span>
        </div>
        <p className="mt-3 min-h-8 font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted/80">
          No account required
        </p>
      </div>
    )
  }

  if (tier.lifetimePrice !== null) {
    return (
      <div>
        <div className="flex items-baseline gap-2.5">
          <span className="font-serif text-4xl font-normal leading-none text-ink-inverted lg:text-5xl">
            ${tier.lifetimePrice}
          </span>
          <span className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-dark-muted">
            paid once
          </span>
        </div>
        <p className="mt-3 min-h-8 font-mono-accent text-[11px] uppercase tracking-[0.18em] text-terracotta">
          Lifetime · all future features
        </p>
      </div>
    )
  }

  const showAnnual = cadence === 'annual'
  const displayPrice = showAnnual ? tier.annualMonthlyEquivalent : tier.monthlyPrice

  return (
    <div>
      <div className="flex items-baseline gap-2.5">
        <motion.span
          key={displayPrice}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: TIER_EASE }}
          className={cn(
            'font-serif text-4xl font-normal leading-none lg:text-5xl',
            isFounding ? 'text-ink-inverted' : 'text-ink'
          )}
        >
          ${displayPrice}
        </motion.span>
        <span className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
          / month
        </span>
      </div>
      <p
        className={cn(
          'mt-3 min-h-8 font-mono-accent text-[11px] uppercase tracking-[0.18em]',
          showAnnual ? 'text-terracotta' : 'text-muted/80'
        )}
      >
        {showAnnual
          ? `Billed $${tier.annualPrice} yearly · save 20%`
          : `or $${tier.annualPrice} / yr ($${tier.annualMonthlyEquivalent}/mo yearly)`}
      </p>
    </div>
  )
}

function BelieverNarrative() {
  return (
    // Dark on purpose, matching the homepage PrivacyShowcase: the site's warm pages take
    // one quiet break for gravitas. The bespoke from-paper-to-dark ramp is gone — nothing
    // else on the site fades into a zone, they cut.
    <section className="relative">
      <div className="zone-dark py-24 md:py-28">
        <Container size="md">
          <div className="grid gap-12 md:grid-cols-[1fr_1.4fr] md:items-center">
            <motion.div {...fadeUp} className="space-y-6">
              <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
                § 03 — The patron
              </p>
              <h2 className="display-section text-ink-inverted!">
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
