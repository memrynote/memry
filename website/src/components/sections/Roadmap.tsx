import { motion } from 'framer-motion'
import { CheckCircle2, Clock, Calendar } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { SectionHeading } from '@/components/shared/SectionHeading'
import { ROADMAP_DATA } from '@/lib/constants'

const statusConfig = {
  done: {
    icon: CheckCircle2,
    color: 'text-emerald-600',
    bgColor: 'bg-emerald-50',
    borderColor: 'border-emerald-200',
    label: 'Complete'
  },
  'in-progress': {
    icon: Clock,
    color: 'text-amber-600',
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-200',
    label: 'In Progress'
  },
  planned: {
    icon: Calendar,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
    label: 'Planned'
  }
} as const

export function Roadmap() {
  return (
    <section className="py-24 bg-card/30">
      <Container>
        <SectionHeading
          title="Building in Public"
          subtitle={`Transparent about our progress. Target release: ${ROADMAP_DATA.releaseDate}`}
        />

        <div className="grid md:grid-cols-3 gap-6 mt-16">
          {ROADMAP_DATA.phases.map((phase, phaseIndex) => {
            const config = statusConfig[phase.status]
            const Icon = config.icon

            return (
              <motion.div
                key={phase.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: phaseIndex * 0.1 }}
                className={`rounded-2xl border ${config.borderColor} ${config.bgColor} p-6`}
              >
                <div className="flex items-center gap-3 mb-4">
                  <div className={`p-2 rounded-lg ${config.bgColor}`}>
                    <Icon className={`w-5 h-5 ${config.color}`} />
                  </div>
                  <div>
                    <span
                      className={`text-xs font-semibold uppercase tracking-wider ${config.color}`}
                    >
                      {config.label}
                    </span>
                    <h3 className="font-display text-lg font-semibold text-foreground">
                      {phase.title}
                    </h3>
                  </div>
                </div>

                <ul className="space-y-2">
                  {phase.items.map((item, itemIndex) => (
                    <motion.li
                      key={item}
                      initial={{ opacity: 0, x: -10 }}
                      whileInView={{ opacity: 1, x: 0 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.3, delay: phaseIndex * 0.1 + itemIndex * 0.05 }}
                      className="flex items-start gap-2 text-sm text-muted"
                    >
                      <span
                        className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                          phase.status === 'done' ? 'bg-emerald-500' : 'bg-current opacity-40'
                        }`}
                      />
                      {item}
                    </motion.li>
                  ))}
                </ul>
              </motion.div>
            )
          })}
        </div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="text-center mt-12 text-sm text-muted"
        >
          Have a feature request?{' '}
          <a
            href="https://github.com/memrynote/memry/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Open an issue on GitHub
          </a>
        </motion.p>
      </Container>
    </section>
  )
}
