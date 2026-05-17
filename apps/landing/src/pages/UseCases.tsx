import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { WaitlistForm } from '@/components/shared/WaitlistForm'
import { PageHead } from '@/components/shared/PageHead'
import { USE_CASES } from '@/lib/constants'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'
import { cn } from '@/lib/utils'

const TICKER_LABELS = [
  'Developer',
  'Student',
  'Freelancer',
  'Creator',
  'Researcher',
  'Designer',
  'Founder',
  'Writer',
  'ADHD',
  'Journalist'
]

const tickerText = TICKER_LABELS.map((l) => `${l}  ·  `).join('')

const sectionVariants = {
  hidden: { opacity: 0, y: 40 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.9, ease: [0.16, 1, 0.3, 1] as const }
  }
}

function WorkflowStep({
  step,
  index,
  total,
  isEven
}: {
  step: string
  index: number
  total: number
  isEven: boolean
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: isEven ? -16 : 16 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true }}
      transition={{
        duration: 0.5,
        delay: 0.3 + index * 0.1,
        ease: [0.16, 1, 0.3, 1]
      }}
      className="flex items-center gap-3"
    >
      <span className="font-mono text-xs text-terracotta/50 w-4 flex-shrink-0">{index + 1}</span>
      <span className="text-sm text-ink/70 leading-relaxed">{step}</span>
      {index < total - 1 && (
        <ArrowRight className="w-3 h-3 text-terracotta/30 flex-shrink-0 hidden sm:block" />
      )}
    </motion.div>
  )
}

function UseCaseSection({
  useCase,
  index
}: {
  useCase: (typeof USE_CASES)[number]
  index: number
}) {
  const isEven = index % 2 === 1
  const number = String(index + 1).padStart(2, '0')
  const Icon = useCase.icon

  return (
    <div>
      {index > 0 && (
        <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent mb-20 md:mb-28" />
      )}

      <motion.div
        variants={sectionVariants}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: '-80px' }}
        className={cn(
          'flex flex-col gap-12 md:gap-16 lg:gap-24 items-start',
          isEven ? 'md:flex-row-reverse' : 'md:flex-row'
        )}
      >
        <div className="flex-1 max-w-lg">
          <div className="flex items-center gap-4 mb-6">
            <span className="font-mono text-sm text-terracotta/50 tracking-widest">{number}</span>
            <Icon className="w-5 h-5 text-terracotta/60" strokeWidth={1.5} />
          </div>

          <h2 className="font-serif text-4xl md:text-5xl lg:text-6xl text-ink leading-[1] tracking-tight mb-6">
            {useCase.title.split(' ').map((word, wi) => (
              <span key={wi} className="block">
                {word}
              </span>
            ))}
          </h2>

          <p className="font-serif italic text-lg md:text-xl text-muted border-l-2 border-terracotta/30 pl-5 max-w-sm leading-relaxed mb-8">
            &ldquo;{useCase.painQuote}&rdquo;
          </p>

          <p className="text-base text-ink/70 leading-relaxed max-w-md">{useCase.description}</p>
        </div>

        <div className="flex-1 flex flex-col gap-10 pt-2 md:pt-12">
          <ul className="space-y-4">
            {useCase.features.map((feature, fi) => (
              <motion.li
                key={feature}
                initial={{ opacity: 0, x: isEven ? -20 : 20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{
                  duration: 0.6,
                  delay: 0.15 + fi * 0.08,
                  ease: [0.16, 1, 0.3, 1]
                }}
                className="flex items-start gap-4 group"
              >
                <div className="w-2 h-2 mt-2.5 rounded-full bg-terracotta/70 group-hover:bg-terracotta transition-colors flex-shrink-0" />
                <span className="text-base md:text-lg text-ink/80 font-medium leading-relaxed">
                  {feature}
                </span>
              </motion.li>
            ))}
          </ul>

          <div className="border border-border/60 rounded-lg p-5 bg-paper-alt/40">
            <p className="font-mono text-xs tracking-widest uppercase text-muted mb-4">Workflow</p>
            <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3 sm:gap-4">
              {useCase.workflow.map((step, si) => (
                <WorkflowStep
                  key={step}
                  step={step}
                  index={si}
                  total={useCase.workflow.length}
                  isEven={isEven}
                />
              ))}
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

export function UseCasesPage() {
  return (
    <main>
      <PageHead page="useCases" />

      <section className="zone-dark relative overflow-hidden pt-32 pb-24 md:pt-40 md:pb-32">
        <div className="absolute inset-0 flex items-center overflow-hidden pointer-events-none select-none">
          <div className="animate-marquee whitespace-nowrap font-mono text-[clamp(4rem,10vw,8rem)] font-bold tracking-tight text-white/[0.04] leading-none">
            <span>{tickerText}</span>
            <span>{tickerText}</span>
          </div>
        </div>

        <Container className="relative z-10">
          <motion.div
            initial={BLUR_REVEAL_INITIAL}
            animate={BLUR_REVEAL_ANIMATE}
            transition={BLUR_REVEAL_TRANSITION}
            className="max-w-3xl"
          >
            <p className="font-mono text-sm tracking-widest uppercase text-terracotta mb-6">
              Use Cases
            </p>
            <h1 className="font-serif text-5xl md:text-7xl lg:text-8xl text-ink-inverted leading-[0.95] mb-8">
              Who are
              <br />
              <span className="text-terracotta">you?</span>
            </h1>
            <p className="text-lg md:text-xl text-dark-muted max-w-md leading-relaxed">
              Seven workflows. One calm workspace.
            </p>
          </motion.div>
        </Container>
      </section>

      <section className="py-20 md:py-32">
        <Container>
          <div className="space-y-20 md:space-y-28">
            {USE_CASES.map((useCase, i) => (
              <UseCaseSection key={useCase.id} useCase={useCase} index={i} />
            ))}
          </div>
        </Container>
      </section>

      <section className="pb-24 md:pb-32">
        <Container>
          <div className="w-full h-px bg-gradient-to-r from-transparent via-terracotta/20 to-transparent mb-24" />
        </Container>
        <Container size="sm">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            className="text-center"
          >
            <h2 className="font-serif text-4xl md:text-5xl text-ink mb-6">Ready to simplify?</h2>
            <p className="text-xl text-muted font-sans mb-12 max-w-lg mx-auto leading-relaxed">
              Join the waitlist and be first to experience a calmer way to work.
            </p>
            <WaitlistForm variant="centered" />
          </motion.div>
        </Container>
      </section>
    </main>
  )
}
