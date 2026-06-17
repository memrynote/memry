import { useRef, type ReactNode } from 'react'
import { motion, useInView } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { WaitlistForm } from '@/components/shared/WaitlistForm'

const BENEFITS = ['Open source', 'Own your data', 'No account required', 'End-to-end encrypted']

const LINE_TRANSITION = { duration: 1, ease: [0.16, 1, 0.3, 1] as const }

function RevealLine({
  children,
  inView,
  delay
}: {
  children: ReactNode
  inView: boolean
  delay: number
}) {
  return (
    <span className="block overflow-hidden pb-[0.08em] -mb-[0.08em]">
      <motion.span
        className="block"
        initial={{ y: '110%' }}
        animate={inView ? { y: 0 } : undefined}
        transition={{ ...LINE_TRANSITION, delay }}
      >
        {children}
      </motion.span>
    </span>
  )
}

export function Hero() {
  const sectionRef = useRef<HTMLElement>(null)
  const isInView = useInView(sectionRef, { once: true, amount: 0.2 })

  return (
    <section ref={sectionRef} id="hero" className="overflow-hidden pt-28 pb-12 md:pt-36 md:pb-16">
      <Container>
        <div className="text-center">
          {/* Front-page headline */}
          <h1 className="mx-auto max-w-4xl font-serif text-5xl leading-[1.05] text-ink text-balance md:text-6xl">
            <RevealLine inView={isInView} delay={0.05}>
              Your thoughts,
            </RevealLine>
            {/* Whitespace text node so the two block lines extract as "thoughts, beautifully" */}{' '}
            <RevealLine inView={isInView} delay={0.18}>
              <span className="relative inline-block italic text-terracotta">
                beautifully organized.
                <svg
                  className="absolute -bottom-2 start-0 h-3 w-full text-terracotta/40 md:-bottom-3"
                  viewBox="0 0 200 10"
                  preserveAspectRatio="none"
                  aria-hidden
                >
                  <motion.path
                    d="M0 7 C 40 2, 60 12, 100 5 S 160 2, 200 7"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    fill="none"
                    strokeLinecap="round"
                    initial={{ pathLength: 0 }}
                    animate={isInView ? { pathLength: 1 } : undefined}
                    transition={{ duration: 0.7, delay: 0.9, ease: [0.65, 0, 0.35, 1] }}
                  />
                </svg>
              </span>
            </RevealLine>
          </h1>

          <motion.p
            className="mx-auto mt-8 max-w-md text-base leading-relaxed text-muted md:text-lg"
            initial={{ opacity: 0, y: 12 }}
            animate={isInView ? { opacity: 1, y: 0 } : undefined}
            transition={{ ...LINE_TRANSITION, delay: 0.45 }}
          >
            Inbox, notes, tasks & journal in one local-first app — synced safely. Private by design,
            open at heart.
          </motion.p>

          <motion.div
            className="mx-auto mt-8 max-w-md"
            id="waitlist"
            initial={{ opacity: 0, y: 12 }}
            animate={isInView ? { opacity: 1, y: 0 } : undefined}
            transition={{ ...LINE_TRANSITION, delay: 0.55 }}
          >
            <WaitlistForm variant="hero" />
          </motion.div>

          <motion.p
            className="mt-8 font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted/70"
            initial={{ opacity: 0 }}
            animate={isInView ? { opacity: 1 } : undefined}
            transition={{ duration: 0.8, delay: 0.75 }}
          >
            {BENEFITS.map((benefit, i) => (
              <span key={benefit} className="inline-block">
                {benefit}
                {i < BENEFITS.length - 1 && (
                  <span aria-hidden className="mx-3 text-terracotta">
                    ✳
                  </span>
                )}
              </span>
            ))}
          </motion.p>
        </div>
      </Container>
    </section>
  )
}
