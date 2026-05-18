import { useRef } from 'react'
import { motion, useInView } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { WaitlistForm } from '@/components/shared/WaitlistForm'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'

const BENEFITS = ['Open source', 'Own your data', 'No account required', 'End-to-end encrypted']

export function Hero() {
  const sectionRef = useRef<HTMLElement>(null)
  const isInView = useInView(sectionRef, { once: true, amount: 0.2 })

  return (
    <section ref={sectionRef} id="hero" className="pt-32 pb-8 md:pt-40 overflow-hidden">
      <Container>
        <div className="flex flex-col items-center">
          <div className="flex flex-col items-center text-center">
            <motion.div
              className="flex flex-col items-center gap-4"
              initial={BLUR_REVEAL_INITIAL}
              animate={isInView ? BLUR_REVEAL_ANIMATE : undefined}
              transition={BLUR_REVEAL_TRANSITION}
            >
              <h1 className="hero-fora-title mx-auto text-ink text-balance">
                Your thoughts,{' '}
                <span className="relative inline-block">
                  <span className="relative z-10 text-terracotta italic">
                    beautifully organized.
                  </span>
                  <svg
                    className="absolute w-full h-3 -bottom-1 left-0 text-terracotta/40"
                    viewBox="0 0 200 10"
                    preserveAspectRatio="none"
                  >
                    <motion.path
                      d="M0 7 C 40 2, 60 12, 100 5 S 160 2, 200 7"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      fill="none"
                      strokeLinecap="round"
                      initial={{ pathLength: 0 }}
                      animate={isInView ? { pathLength: 1 } : undefined}
                      transition={{
                        duration: 0.7,
                        ease: [0.65, 0, 0.35, 1]
                      }}
                    />
                  </svg>
                </span>
              </h1>

              <p className="hero-fora-copy mx-auto text-muted">
                Your private productivity OS for inbox, notes, tasks & journal — synced safely.
                Private by design, open at heart.
              </p>
            </motion.div>

            <motion.div
              className="mx-auto mt-8 mb-8 max-w-md"
              id="waitlist"
              initial={BLUR_REVEAL_INITIAL}
              animate={isInView ? BLUR_REVEAL_ANIMATE : undefined}
              transition={BLUR_REVEAL_TRANSITION}
            >
              <WaitlistForm variant="hero" />
            </motion.div>

            <motion.p
              className="text-xs text-muted/60 font-mono-accent uppercase tracking-widest"
              initial={{ opacity: 0, filter: 'blur(8px)' }}
              animate={isInView ? BLUR_REVEAL_ANIMATE : undefined}
              transition={BLUR_REVEAL_TRANSITION}
            >
              {BENEFITS.map((benefit, i) => (
                <span key={benefit}>
                  {benefit}
                  {i < BENEFITS.length - 1 && <span className="mx-3 text-muted/30">·</span>}
                </span>
              ))}
            </motion.p>
          </div>
        </div>
      </Container>
    </section>
  )
}
