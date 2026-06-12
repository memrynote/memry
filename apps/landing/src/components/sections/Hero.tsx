import { useRef, type ReactNode } from 'react'
import { motion, useInView } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { WaitlistForm } from '@/components/shared/WaitlistForm'
import { DESKTOP_RELEASE_TIMING } from '@/lib/constants'

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
        {/* Masthead rule */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : undefined}
          transition={{ duration: 0.8 }}
        >
          <div className="rule-double text-ink/25" aria-hidden />
          <div className="flex items-baseline justify-between gap-4 pt-3 font-mono-accent text-[10px] uppercase tracking-[0.2em] text-muted/70 sm:text-[11px]">
            <span>The private productivity OS</span>
            <span className="hidden sm:inline">Vol. 1 — First edition</span>
            <span className="text-terracotta">{DESKTOP_RELEASE_TIMING}</span>
          </div>
        </motion.div>

        <div className="grid gap-10 pt-14 md:pt-20 lg:grid-cols-[1fr_auto] lg:gap-16">
          {/* Front-page headline */}
          <div className="max-w-4xl">
            <h1 className="display-hero text-ink text-balance">
              <RevealLine inView={isInView} delay={0.05}>
                Your thoughts,
              </RevealLine>
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
              className="mt-8 max-w-md text-base leading-relaxed text-muted md:text-lg"
              initial={{ opacity: 0, y: 12 }}
              animate={isInView ? { opacity: 1, y: 0 } : undefined}
              transition={{ ...LINE_TRANSITION, delay: 0.45 }}
            >
              Inbox, notes, tasks & journal in one local-first app — synced safely. Private by
              design, open at heart.
            </motion.p>

            <motion.div
              className="mt-8 max-w-md"
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

          {/* Marginalia column */}
          <motion.aside
            aria-hidden
            className="hidden select-none items-start gap-5 lg:flex"
            initial={{ opacity: 0 }}
            animate={isInView ? { opacity: 1 } : undefined}
            transition={{ duration: 1, delay: 0.9 }}
          >
            <div className="marginalia-vertical font-mono-accent text-[10px] uppercase tracking-[0.3em] text-muted/50">
              Capture · Reflect · Organize · Act
            </div>
            <div className="flex flex-col items-center gap-5">
              <div className="h-28 w-px bg-ink/20" />
              <span className="ink-stamp -rotate-6 text-[10px]">
                Desktop
                <br />
                first
              </span>
              <div className="h-28 w-px bg-ink/20" />
            </div>
          </motion.aside>
        </div>
      </Container>
    </section>
  )
}
