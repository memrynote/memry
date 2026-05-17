import { useRef, useState, useEffect } from 'react'
import { motion, useScroll, useTransform } from 'framer-motion'
import { Inbox, BookOpen, FileText, CheckSquare } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { SectionHeading } from '@/components/shared/SectionHeading'

const WORKFLOW_STEPS = [
  {
    icon: Inbox,
    label: 'Capture',
    description: 'Thought pops up? Toss it in the Inbox. No organizing, no friction.'
  },
  {
    icon: BookOpen,
    label: 'Reflect',
    description: 'Your daily journal surfaces context — schedule, tasks, recent captures.'
  },
  {
    icon: FileText,
    label: 'Connect',
    description: 'Link notes together with [[wiki-links]]. Ideas form a web, not a pile.'
  },
  {
    icon: CheckSquare,
    label: 'Execute',
    description: 'Turn insights into tasks. Kanban, calendar, or list — your call.'
  }
] as const

function StepCard({ step, index }: { step: (typeof WORKFLOW_STEPS)[number]; index: number }) {
  const Icon = step.icon
  const num = String(index + 1).padStart(2, '0')

  return (
    <div className="relative flex flex-col items-center text-center px-6 py-8 group">
      <span className="absolute inset-0 flex items-center justify-center font-serif text-[12rem] md:text-[16rem] text-ink/[0.03] select-none pointer-events-none leading-none">
        {num}
      </span>

      <div className="relative mb-5">
        <div className="absolute -inset-3 bg-terracotta/8 rounded-full blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
        <div className="relative w-16 h-16 rounded-2xl bg-card border border-border flex items-center justify-center shadow-sm group-hover:border-terracotta/30 transition-colors">
          <Icon className="w-7 h-7 text-terracotta" strokeWidth={1.5} />
        </div>
      </div>

      <span className="text-xs font-mono-accent uppercase tracking-wider text-terracotta mb-2">
        {num}
      </span>
      <h3 className="font-serif text-xl text-ink mb-2">{step.label}</h3>
      <p className="text-sm text-muted leading-relaxed max-w-[200px]">{step.description}</p>
    </div>
  )
}

function ScrollDots({ activeIndex }: { activeIndex: number }) {
  return (
    <div className="flex justify-center gap-2 mt-6 lg:hidden">
      {WORKFLOW_STEPS.map((_, i) => (
        <div
          key={i}
          className={`w-2 h-2 rounded-full transition-colors duration-300 ${
            i === activeIndex ? 'bg-terracotta' : 'bg-border'
          }`}
        />
      ))}
    </div>
  )
}

export function FeatureFlow() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  const { scrollXProgress } = useScroll({ container: scrollRef })
  const lineScaleX = useTransform(scrollXProgress, [0, 1], [0, 1])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    function onScroll() {
      if (!el) return
      const scrollLeft = el.scrollLeft
      const childWidth = el.scrollWidth / WORKFLOW_STEPS.length
      const idx = Math.round(scrollLeft / childWidth)
      setActiveIndex(Math.min(idx, WORKFLOW_STEPS.length - 1))
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <section className="py-24 overflow-hidden">
      <Container>
        <SectionHeading
          title="From thought to done"
          subtitle="A natural flow that matches how your brain actually works."
        />
      </Container>

      {/* Desktop: 4-column grid */}
      <Container>
        <div className="hidden lg:block mt-16 max-w-5xl mx-auto">
          <div className="grid grid-cols-4 gap-4 relative">
            {WORKFLOW_STEPS.map((step, index) => (
              <motion.div
                key={step.label}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.6, delay: index * 0.12, ease: [0.16, 1, 0.3, 1] }}
              >
                <StepCard step={step} index={index} />
              </motion.div>
            ))}

            <div className="absolute top-1/2 left-[12.5%] right-[12.5%] h-px bg-border/40 -translate-y-1/2 -z-0">
              <motion.div
                className="h-full bg-terracotta/20 origin-left"
                style={{ scaleX: lineScaleX }}
              />
            </div>
          </div>
        </div>
      </Container>

      {/* Mobile: horizontal scroll */}
      <div className="lg:hidden mt-16">
        <div
          ref={scrollRef}
          className="flex overflow-x-auto snap-x-mandatory gap-4 px-6 pb-4 scrollbar-hide"
        >
          {WORKFLOW_STEPS.map((step, index) => (
            <div key={step.label} className="min-w-[80vw] md:min-w-[50vw] snap-center shrink-0">
              <StepCard step={step} index={index} />
            </div>
          ))}
        </div>

        <div className="relative mx-6 h-px bg-border/30">
          <motion.div
            className="h-full bg-terracotta/30 origin-left"
            style={{ scaleX: lineScaleX }}
          />
        </div>

        <ScrollDots activeIndex={activeIndex} />
      </div>
    </section>
  )
}
