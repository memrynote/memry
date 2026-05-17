import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { SectionHeading } from '@/components/shared/SectionHeading'
import { FEATURES } from '@/lib/constants'
import { cn } from '@/lib/utils'

const STACKED_FEATURES = FEATURES.slice(0, 5)

const FEATURE_ACCENTS = [
  'border-terracotta/35 bg-terracotta/10 text-terracotta',
  'border-sage/35 bg-sage/10 text-sage',
  'border-ink/15 bg-ink/10 text-ink dark:border-white/15 dark:bg-white/10 dark:text-ink',
  'border-brand-400/35 bg-brand-400/10 text-brand-600 dark:text-brand-300',
  'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300'
] as const

type Feature = (typeof FEATURES)[number]

function FeatureStackCard({
  feature,
  index,
  total
}: {
  feature: Feature
  index: number
  total: number
}) {
  const Icon = feature.icon
  const accent = FEATURE_ACCENTS[index % FEATURE_ACCENTS.length]

  return (
    <motion.article
      className="relative md:sticky md:top-28"
      style={{ zIndex: index + 1 }}
      initial={{ opacity: 0, y: 32, filter: 'blur(8px)' }}
      whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="group relative overflow-hidden rounded-2xl border border-border/70 bg-card shadow-elevated">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-terracotta/50 to-transparent" />

        <div className="grid min-h-[560px] md:min-h-[540px] md:grid-cols-[0.58fr_1.42fr]">
          <div className="order-2 flex flex-col justify-between gap-8 p-6 sm:p-8 md:order-1 md:p-8 lg:p-10">
            <div>
              <div className="mb-8 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      'flex h-10 w-10 items-center justify-center rounded-full border',
                      accent
                    )}
                  >
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="font-mono-accent text-xs uppercase tracking-[0.18em] text-muted/60">
                    {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
                  </span>
                </div>
                <span className="hidden rounded-full border border-border/70 px-3 py-1 text-xs font-medium text-muted md:inline-flex">
                  {index === 0 ? 'Start here' : 'Then'}
                </span>
              </div>

              <h3 className="font-serif text-4xl leading-none text-ink sm:text-5xl">
                {feature.title}
              </h3>

              <p className="mt-5 max-w-sm font-serif text-2xl italic leading-tight text-terracotta">
                {feature.tagline}
              </p>

              <p className="mt-6 max-w-md text-base leading-7 text-muted sm:text-lg">
                {feature.description}
              </p>
            </div>

            <ul className="grid gap-3 sm:grid-cols-2">
              {feature.highlights.map((highlight) => (
                <li
                  key={highlight}
                  className="flex items-start gap-3 text-sm font-medium text-ink/80"
                >
                  <span className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-terracotta" />
                  {highlight}
                </li>
              ))}
            </ul>
          </div>

          <div className="relative order-1 min-h-[260px] overflow-hidden bg-paper-deep md:order-2 md:min-h-full">
            <img
              src={feature.screenshot}
              alt={`${feature.title} feature screenshot`}
              className="h-full w-full object-cover object-left-top transition-transform duration-700 ease-out group-hover:scale-[1.025]"
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/20 via-transparent to-white/10" />
            <div className="pointer-events-none absolute inset-y-0 start-0 hidden w-16 bg-gradient-to-r from-card to-transparent md:block" />
          </div>
        </div>
      </div>
    </motion.article>
  )
}

export function Features() {
  return (
    <section id="features" className="py-24">
      <Container>
        <SectionHeading
          title="What's inside"
          subtitle="Everything you need to capture, organize, and act on your ideas. Nothing you don't."
        />

        <div className="relative mt-16 space-y-6 md:space-y-8 md:[perspective:1200px]">
          {STACKED_FEATURES.map((feature, index) => (
            <FeatureStackCard
              key={feature.id}
              feature={feature}
              index={index}
              total={STACKED_FEATURES.length}
            />
          ))}
        </div>
      </Container>
    </section>
  )
}
