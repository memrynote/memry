import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { SectionHeading } from '@/components/shared/SectionHeading'
import { FLOW_STEPS } from '@/lib/constants'
import { cn } from '@/lib/utils'

const TIER_WIDTHS = ['max-w-2xl', 'max-w-xl', 'max-w-lg', 'max-w-md', 'max-w-sm'] as const

function ConnectorArrow({ index }: { index: number }) {
  return (
    <motion.div
      className="flex flex-col items-center py-2"
      initial={{ opacity: 0, scaleY: 0 }}
      whileInView={{ opacity: 1, scaleY: 1 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{
        duration: 0.4,
        delay: index * 0.1,
        ease: [0.16, 1, 0.3, 1]
      }}
      style={{ transformOrigin: 'top' }}
    >
      <div className="w-px h-8 bg-gradient-to-b from-border to-terracotta/30" />
      <div className="w-0 h-0 border-l-[5px] border-r-[5px] border-t-[6px] border-l-transparent border-r-transparent border-t-terracotta/40" />
    </motion.div>
  )
}

function CompetitorLogos({
  competitors
}: {
  competitors: ReadonlyArray<{ readonly name: string; readonly logo: string }>
}) {
  if (competitors.length === 0) return null

  return (
    <div className="flex items-center gap-2.5 mt-3">
      <span className="text-[10px] font-mono-accent uppercase tracking-wider text-muted/60">
        Compare to
      </span>
      <div className="flex items-center gap-1.5">
        {competitors.map((c) => (
          <img
            key={c.name}
            src={c.logo}
            alt={c.name}
            title={c.name}
            className="w-5 h-5 rounded-sm opacity-50 grayscale hover:opacity-100 hover:grayscale-0 transition-all duration-200"
          />
        ))}
      </div>
    </div>
  )
}

function FunnelTier({ step, index }: { step: (typeof FLOW_STEPS)[number]; index: number }) {
  const Icon = step.icon

  return (
    <motion.div
      className={cn('w-full mx-auto', TIER_WIDTHS[index])}
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{
        duration: 0.6,
        delay: index * 0.08,
        ease: [0.16, 1, 0.3, 1]
      }}
    >
      <div
        className={cn(
          'relative px-6 py-5 rounded-xl',
          'border border-border/60 bg-card/60 backdrop-blur-sm',
          'transition-all duration-300',
          'hover:border-terracotta/30 hover:shadow-card'
        )}
      >
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-terracotta/8 flex items-center justify-center">
            <Icon className="w-5 h-5 text-terracotta/70" strokeWidth={1.5} />
          </div>

          <div className="flex-1 min-w-0">
            <h3 className="font-serif text-xl text-ink">{step.title}</h3>
            <p className="text-sm text-muted font-sans leading-relaxed mt-0.5">{step.tagline}</p>
            <CompetitorLogos competitors={step.competitors} />
          </div>
        </div>

        <div
          className="absolute -left-3 top-1/2 -translate-y-1/2 w-1.5 h-8 rounded-full bg-terracotta/20"
          aria-hidden
        />
      </div>
    </motion.div>
  )
}

export function FlowFunnel() {
  return (
    <section className="py-24 zone-transition">
      <Container size="md">
        <SectionHeading
          title="One app, one flow"
          subtitle="From raw thought to scheduled action — everything narrows into clarity."
        />

        <div className="flex flex-col items-center">
          {FLOW_STEPS.map((step, index) => (
            <div key={step.id} className="w-full flex flex-col items-center">
              <FunnelTier step={step} index={index} />
              {index < FLOW_STEPS.length - 1 && <ConnectorArrow index={index} />}
            </div>
          ))}
        </div>
      </Container>
    </section>
  )
}
