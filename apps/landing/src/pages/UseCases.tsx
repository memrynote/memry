import { motion } from 'motion/react'
import { ArrowRight } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { FinalCta } from '@/components/site/FinalCta'
import { PageHero } from '@/components/site/PageHero'
import { FeatureChip } from '@/components/site/primitives'
import { USE_CASES } from '@/lib/constants'
import { SITE_TINTS } from '@/lib/site-tints'
import { cn } from '@/lib/utils'

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
    // The id gives the hero chips somewhere to land — scroll-mt clears the fixed nav pill.
    <div id={useCase.id} className="scroll-mt-28">
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

/** The personas as hero chips — each one an in-page anchor down to its section. */
function PersonaChips() {
  return (
    <>
      {USE_CASES.map((useCase) => {
        const Icon = useCase.icon

        return (
          <FeatureChip
            key={useCase.id}
            href={`#${useCase.id}`}
            label={useCase.title}
            icon={<Icon className="h-4 w-4" strokeWidth={1.5} />}
          />
        )
      })}
    </>
  )
}

export function UseCasesPage() {
  return (
    <>
      <PageHead page="useCases" />
      <PageHero
        tint={SITE_TINTS.useCases}
        eyebrow="Use cases"
        title={
          <>
            Who are <span className="text-terracotta">you?</span>
          </>
        }
        sub="Seven workflows. One calm workspace."
        actions={<PersonaChips />}
      />

      <section className="py-20 md:py-32">
        <Container>
          <div className="space-y-20 md:space-y-28">
            {USE_CASES.map((useCase, i) => (
              <UseCaseSection key={useCase.id} useCase={useCase} index={i} />
            ))}
          </div>
        </Container>
      </section>

      <FinalCta
        title="Ready to simplify?"
        sub="Download memrynote and experience a calmer way to work."
        location="usecases-final"
      />
    </>
  )
}
