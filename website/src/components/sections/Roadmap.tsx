import { motion } from 'framer-motion'
import { CheckCircle2, Clock, Calendar } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { SectionHeading } from '@/components/shared/SectionHeading'
import { ROADMAP_DATA, TWITTER_DEV_URL } from '@/lib/constants'

const statusConfig = {
  done: {
    icon: CheckCircle2,
    color: 'text-sage',
    bgColor: 'bg-sage/10',
    borderColor: 'border-sage/20',
    label: 'Complete'
  },
  'in-progress': {
    icon: Clock,
    color: 'text-terracotta',
    bgColor: 'bg-terracotta/10',
    borderColor: 'border-terracotta/20',
    label: 'In Progress'
  },
  planned: {
    icon: Calendar,
    color: 'text-muted',
    bgColor: 'bg-muted/10',
    borderColor: 'border-muted/20',
    label: 'Planned'
  }
} as const

export function Roadmap() {
  return (
    <section id="roadmap" className="py-24 bg-white/40 border-y border-border/40">
      <Container>
        <SectionHeading
          title="Building in Public"
          subtitle={`Transparent about our progress. Target release: ${ROADMAP_DATA.releaseDate}`}
        />

        <div className="grid md:grid-cols-3 gap-8 mt-16">
          {ROADMAP_DATA.phases.map((phase, phaseIndex) => {
            const config = statusConfig[phase.status]
            const Icon = config.icon

            return (
              <motion.div
                key={phase.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.8, delay: phaseIndex * 0.15, ease: [0.16, 1, 0.3, 1] }}
                className={`rounded-xl border ${config.borderColor} ${config.bgColor} p-8 relative overflow-hidden group`}
              >
                <div className="absolute top-0 right-0 p-3 opacity-10 group-hover:opacity-20 transition-opacity">
                  <Icon className="w-24 h-24" />
                </div>

                <div className="relative z-10">
                  <div className="flex items-center gap-3 mb-6">
                    <span
                      className={`text-xs font-mono-accent font-medium uppercase tracking-wider px-2 py-1 rounded bg-white/50 ${config.color}`}
                    >
                      {config.label}
                    </span>
                  </div>

                  <h3 className="font-serif text-2xl font-normal text-ink mb-6">{phase.title}</h3>

                  <ul className="space-y-3">
                    {phase.items.map((item, itemIndex) => (
                      <motion.li
                        key={item}
                        initial={{ opacity: 0, x: -10 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.3, delay: phaseIndex * 0.1 + itemIndex * 0.05 }}
                        className="flex items-start gap-3 text-sm text-ink/80"
                      >
                        <span
                          className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                            phase.status === 'done'
                              ? 'bg-sage'
                              : phase.status === 'in-progress'
                                ? 'bg-terracotta'
                                : 'bg-muted/40'
                          }`}
                        />
                        {item}
                      </motion.li>
                    ))}
                  </ul>
                </div>
              </motion.div>
            )
          })}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="text-center mt-12 space-y-2"
        >
          <p className="text-sm text-muted">
            Have a feature request?{' '}
            <a
              href="https://github.com/memrynote/memry/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="text-terracotta hover:underline font-medium"
            >
              Open an issue on GitHub
            </a>
          </p>
          <p className="text-sm text-muted">
            Follow the developer{' '}
            <a
              href={TWITTER_DEV_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-terracotta hover:underline font-medium"
            >
              @h4yfans
            </a>{' '}
            for updates
          </p>
        </motion.div>
      </Container>
    </section>
  )
}
