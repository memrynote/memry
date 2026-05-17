import { motion } from 'framer-motion'
import { Check } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { GITHUB_URL, ROADMAP_DATA, TWITTER_DEV_URL } from '@/lib/constants'
import { trackLandingEvent } from '@/lib/analytics'

const STATUS_CONFIG = {
  done: {
    node: 'bg-sage border-sage',
    badge: 'text-sage bg-sage/10',
    label: 'Shipped',
    dot: 'bg-sage'
  },
  'in-progress': {
    node: 'bg-terracotta border-terracotta',
    badge: 'text-terracotta bg-terracotta/10',
    label: 'Building now',
    dot: 'bg-terracotta'
  },
  planned: {
    node: 'border-muted/40 border-dashed bg-paper',
    badge: 'text-muted bg-muted/10',
    label: 'Up next',
    dot: 'bg-muted/30'
  }
} as const

export function Roadmap() {
  const totalItems = ROADMAP_DATA.phases.reduce((sum, p) => sum + p.items.length, 0)
  const shippedItems = ROADMAP_DATA.phases
    .filter((p) => p.status === 'done')
    .reduce((sum, p) => sum + p.items.length, 0)

  return (
    <section id="roadmap" className="py-24 border-t border-border/40">
      <Container size="md">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="mb-16"
        >
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
            <div>
              <h2 className="font-serif text-4xl md:text-5xl text-ink">Building in public</h2>
              <p className="text-muted mt-2">
                {ROADMAP_DATA.earlyAccess}. Transparent about every step.
              </p>
            </div>
            <span className="font-mono-accent text-xs text-muted tracking-wider uppercase whitespace-nowrap">
              {shippedItems}/{totalItems} features shipped
            </span>
          </div>

          <div className="h-1 bg-border/30 rounded-full overflow-hidden">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-sage to-sage/70"
              initial={{ width: 0 }}
              whileInView={{ width: `${(shippedItems / totalItems) * 100}%` }}
              viewport={{ once: true }}
              transition={{ duration: 1.2, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
            />
          </div>
        </motion.div>

        <div className="relative">
          <div
            className="absolute left-[11px] top-3 bottom-3 w-px"
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
          className="mt-14 flex items-start gap-4 rounded-xl border border-terracotta/20 bg-terracotta/5 p-5"
        >
          <span className="text-2xl shrink-0" role="img" aria-label="mobile phone">
            {'\u{1F4F1}'}
          </span>
          <div>
            <p className="text-ink font-medium text-sm">
              Mobile apps &mdash; iOS & Android targeting late 2026
            </p>
            <p className="text-muted text-sm mt-1">
              memrynote Sync is built in. You can also use any cloud folder you prefer (iCloud,
              Dropbox, Google Drive, Syncthing).
            </p>
          </div>
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
            className="text-terracotta hover:underline font-medium"
            onClick={() => trackLandingEvent('landing_external_click', 'roadmap:github-issues')}
          >
            Request a feature →
          </a>
          <span className="text-border hidden sm:inline">|</span>
          <a
            href={TWITTER_DEV_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-terracotta hover:underline font-medium"
            onClick={() => trackLandingEvent('landing_external_click', 'roadmap:twitter')}
          >
            Follow @h4yfans for updates →
          </a>
        </motion.div>
      </Container>
    </section>
  )
}
