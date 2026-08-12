import { motion } from 'motion/react'
import { Link } from 'react-router'
import { ArrowRight, Check } from 'lucide-react'
import { HomeSection, SectionTitle } from '@/components/site/primitives'
import { SYNC_PLAN_TIERS, type SyncPlanId, type SyncPlanTier } from '@/lib/constants'
import { trackLandingEvent } from '@/lib/analytics'
import { cn } from '@/lib/utils'

const EASE = [0.16, 1, 0.3, 1] as const

function tierById(id: SyncPlanId): SyncPlanTier {
  const tier = SYNC_PLAN_TIERS.find((item) => item.id === id)
  if (!tier) throw new Error(`Missing pricing tier: ${id}`)
  return tier
}

function TeaserPrice({ tier, featured }: { tier: SyncPlanTier; featured: boolean }) {
  if (tier.id === 'free') {
    return (
      <div className="mt-6">
        <div className="flex items-baseline gap-2.5">
          <span className="font-serif text-4xl font-normal leading-none text-ink lg:text-5xl">
            $0
          </span>
          <span className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
            forever
          </span>
        </div>
        <p className="mt-3 min-h-4 font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted/80">
          No account required
        </p>
      </div>
    )
  }

  return (
    <div className="mt-6">
      <div className="flex items-baseline gap-2.5">
        <span
          className={cn(
            'font-serif text-4xl font-normal leading-none lg:text-5xl',
            featured ? 'text-terracotta' : 'text-ink'
          )}
        >
          ${tier.monthlyPrice}
        </span>
        <span className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
          / month
        </span>
      </div>
      <p className="mt-3 min-h-4 font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted/80">
        or ${tier.annualPrice} / yr (${tier.annualMonthlyEquivalent}/mo yearly)
      </p>
    </div>
  )
}

function TeaserCard({
  tier,
  featured = false,
  delay
}: {
  tier: SyncPlanTier
  featured?: boolean
  delay: number
}) {
  const baseline = tier.features[0]?.startsWith('Everything in') ? tier.features[0] : null
  const features = baseline ? tier.features.slice(1) : tier.features

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.7, delay, ease: EASE }}
      className="h-full"
    >
      <Link
        to="/pricing"
        onClick={() =>
          trackLandingEvent('landing_pricing_cta_click', `pricing:${tier.id}:home-teaser`)
        }
        className={cn(
          'group relative flex h-full flex-col rounded-3xl border p-7 transition-all duration-300 hover:-translate-y-1 hover:shadow-card md:p-8',
          featured
            ? 'border-terracotta/50 bg-terracotta/[0.05]'
            : 'border-border bg-card hover:border-ink/15'
        )}
      >
        {featured && (
          <>
            <div
              className="absolute inset-x-8 top-0 h-[3px] rounded-b-full bg-terracotta"
              aria-hidden
            />
            {tier.ribbon && (
              <span className="absolute -top-3 inset-x-0 mx-auto w-fit rounded-full bg-terracotta px-3 py-1 font-mono-accent text-[10px] uppercase tracking-[0.16em] text-white">
                {tier.ribbon}
              </span>
            )}
          </>
        )}

        <h3 className="font-serif text-2xl font-normal text-ink">{tier.name}</h3>
        <p className="mt-1.5 font-serif text-sm italic leading-snug text-muted">{tier.tagline}</p>

        <TeaserPrice tier={tier} featured={featured} />

        <div className={cn('mt-6 h-px', featured ? 'bg-terracotta/20' : 'bg-ink/10')} aria-hidden />

        <ul className="mt-5 flex-1 space-y-2.5">
          {baseline && (
            <li className="font-mono-accent text-[10px] uppercase tracking-[0.14em] text-muted">
              {baseline}, plus —
            </li>
          )}
          {features.map((feature) => (
            <li key={feature} className="flex items-start gap-2.5 text-[13px]">
              <Check
                className={cn(
                  'mt-0.5 h-3.5 w-3.5 shrink-0',
                  featured ? 'text-terracotta' : 'text-sage'
                )}
                strokeWidth={2.5}
                aria-hidden
              />
              <span className="leading-relaxed text-ink/80">{feature}</span>
            </li>
          ))}
        </ul>

        <span
          className={cn(
            'mt-7 inline-flex items-center gap-1.5 font-mono-accent text-[11px] uppercase tracking-[0.18em]',
            featured ? 'text-terracotta' : 'text-muted group-hover:text-ink'
          )}
        >
          Learn more
          <ArrowRight
            className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5"
            aria-hidden
          />
        </span>
      </Link>
    </motion.div>
  )
}

export function PricingTeaser() {
  const freeTier = tierById('free')
  const proTier = tierById('pro')

  return (
    <HomeSection id="pricing-teaser">
      <SectionTitle
        eyebrow="Pricing"
        title="Your pace, your plan"
        sub="The app is free on your device. Paid sync keeps your vault everywhere — end-to-end encrypted before a single byte leaves."
      />

      <div className="mx-auto mt-12 grid max-w-3xl gap-5 md:grid-cols-2">
        <TeaserCard tier={freeTier} delay={0} />
        <TeaserCard tier={proTier} featured delay={0.1} />
      </div>

      <motion.p
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.7, delay: 0.25, ease: EASE }}
        className="mt-8 text-center text-sm text-muted"
      >
        <Link
          to="/pricing"
          className="inline-flex items-center gap-1.5 transition-colors hover:text-ink"
        >
          Compare every plan and limit
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </motion.p>
    </HomeSection>
  )
}
