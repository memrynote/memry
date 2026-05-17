import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { ArrowRight, Check } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { GITHUB_URL, ROADMAP_DATA, TWITTER_DEV_URL } from '@/lib/constants'
import { trackLandingEvent } from '@/lib/analytics'

const STATUS_CONFIG = {
  done: {
    node: 'bg-sage border-sage',
    badge: 'text-sage bg-sage/10',
    label: 'Shipped',
    countLabel: 'available',
    dot: 'bg-sage'
  },
  'in-progress': {
    node: 'bg-terracotta border-terracotta',
    badge: 'text-terracotta bg-terracotta/10',
    label: 'Building now',
    countLabel: 'active',
    dot: 'bg-terracotta'
  },
  planned: {
    node: 'border-muted/40 border-dashed bg-paper',
    badge: 'text-muted bg-muted/10',
    label: 'Up next',
    countLabel: 'planned',
    dot: 'bg-muted/30'
  }
} as const

export function Roadmap() {
  return (
    <section id="roadmap" className="py-24 border-t border-border/40">
      <Container size="md">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="mb-14"
        >
          <div className="grid gap-8 lg:grid-cols-[1fr_minmax(280px,360px)] lg:items-end">
            <div>
              <p className="font-mono-accent text-xs uppercase tracking-[0.18em] text-terracotta">
                Roadmap snapshot
              </p>
              <h2 className="mt-3 font-serif text-4xl text-ink md:text-5xl">Building in public</h2>
              <p className="mt-3 max-w-2xl text-lg leading-relaxed text-muted">
                {ROADMAP_DATA.earlyAccess}. Here is what already works, what is active now, and what
                is planned next.
              </p>
            </div>

            <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-border/60 bg-border/60 text-center">
              {ROADMAP_DATA.phases.map((phase) => {
                const config = STATUS_CONFIG[phase.status]

                return (
                  <div key={phase.status} className="bg-paper px-3 py-4">
                    <span className="block font-serif text-3xl leading-none text-ink">
                      {phase.items.length}
                    </span>
                    <span className="mt-2 block font-mono-accent text-[10px] uppercase tracking-[0.16em] text-muted">
                      {config.countLabel}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </motion.div>

        <div className="relative">
          <div
            className="absolute start-[11px] top-3 bottom-3 w-px"
            style={{
              background:
                'linear-gradient(to bottom, var(--color-sage), var(--color-terracotta) 50%, var(--color-border) 100%)',
              opacity: 0.5
            }}
          />

          <div className="space-y-14">
            {ROADMAP_DATA.phases.map((phase) => {
              const config = STATUS_CONFIG[phase.status]

              return (
                <motion.div
                  key={phase.title}
                  initial={{ opacity: 0 }}
                  whileInView={{ opacity: 1 }}
                  viewport={{ once: true, margin: '-50px' }}
                  transition={{ duration: 0.5 }}
                  className="flex gap-6 md:gap-8"
                >
                  <div className="shrink-0 pt-1">
                    <div
                      className={`relative z-10 w-[23px] h-[23px] rounded-full border-2 flex items-center justify-center ${config.node}`}
                    >
                      {phase.status === 'done' && (
                        <Check className="w-3 h-3 text-white" strokeWidth={3} />
                      )}
                      {phase.status === 'in-progress' && (
                        <>
                          <span className="w-2 h-2 rounded-full bg-white" />
                          <span className="absolute inset-0 rounded-full border-2 border-terracotta animate-ping opacity-20" />
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-3 mb-4">
                      <h3 className="font-serif text-2xl text-ink">{phase.title}</h3>
                      <span
                        className={`text-xs font-mono-accent uppercase tracking-wider px-2 py-0.5 rounded ${config.badge}`}
                      >
                        {config.label}
                      </span>
                    </div>
                    <p className="mb-4 max-w-2xl text-sm leading-relaxed text-muted">
                      {phase.caption}
                    </p>

                    <div className="grid sm:grid-cols-2 gap-x-8 gap-y-1.5">
                      {phase.items.map((item) => (
                        <div
                          key={item}
                          className={`flex items-center gap-2.5 py-1 text-sm ${
                            phase.status === 'planned' ? 'text-muted' : 'text-ink/80'
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${config.dot}`} />
                          {item}
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )
            })}
          </div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mt-14 rounded-lg border border-border/70 bg-paper-alt p-5 md:flex md:items-center md:justify-between md:gap-6"
        >
          <div>
            <p className="text-ink font-medium text-sm">Want the full roadmap?</p>
            <p className="text-muted text-sm mt-1">
              Active work, planned bets, and launched history live on the dedicated roadmap page.
            </p>
          </div>
          <Link
            to="/roadmap"
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-terracotta/25 px-4 py-2 text-sm font-medium text-terracotta transition-colors hover:border-terracotta/40 hover:bg-terracotta/10 md:mt-0"
            onClick={() => trackLandingEvent('landing_nav_click', 'roadmap:full-roadmap')}
          >
            View full roadmap
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="mt-8 pt-8 border-t border-border/40 flex flex-wrap items-center justify-center gap-6 text-sm text-muted"
        >
          <a
            href={`${GITHUB_URL}/issues`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-terracotta hover:underline font-medium"
            onClick={() => trackLandingEvent('landing_external_click', 'roadmap:github-issues')}
          >
            Request a feature
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </a>
          <span className="text-border hidden sm:inline">|</span>
          <a
            href={TWITTER_DEV_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-terracotta hover:underline font-medium"
            onClick={() => trackLandingEvent('landing_external_click', 'roadmap:twitter')}
          >
            Follow @h4yfans for updates
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </a>
        </motion.div>
      </Container>
    </section>
  )
}
