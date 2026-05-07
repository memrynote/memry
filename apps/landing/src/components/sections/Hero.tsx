import { useRef } from 'react'
import { motion, useInView } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { WaitlistForm } from '@/components/shared/WaitlistForm'

const BENEFITS = ['Open source', 'Own your data', 'End-to-end encrypted']

const SUBTITLE_DELAY = 0.5
const FORM_DELAY = 0.7
const BENEFITS_DELAY = 0.85

export function Hero() {
  const sectionRef = useRef<HTMLElement>(null)
  const isInView = useInView(sectionRef, { once: true, amount: 0.2 })

  return (
    <section ref={sectionRef} id="hero" className="pt-32 pb-8 md:pt-40 overflow-hidden">
      <Container>
        <div className="flex flex-col items-center">
          <div className="text-center">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : undefined}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            >
              <h1 className="font-serif text-4xl md:text-5xl lg:text-6xl font-normal text-ink leading-[1.08] tracking-tight md:whitespace-nowrap">
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
                        delay: 0.4,
                        ease: [0.65, 0, 0.35, 1]
                      }}
                    />
                  </svg>
                </span>
              </h1>
            </motion.div>

            <motion.p
              className="text-base md:text-lg text-muted font-sans max-w-md mx-auto mt-5 mb-8 leading-relaxed"
              initial={{ opacity: 0, y: 16 }}
              animate={isInView ? { opacity: 1, y: 0 } : undefined}
              transition={{
                duration: 0.6,
                delay: SUBTITLE_DELAY,
                ease: [0.16, 1, 0.3, 1]
              }}
            >
              One app for inbox, notes, tasks & journal — private by design, open at heart.
            </motion.p>

            <motion.div
              className="max-w-md mx-auto mb-8"
              id="waitlist"
              initial={{ opacity: 0, y: 24 }}
              animate={isInView ? { opacity: 1, y: 0 } : undefined}
              transition={{
                duration: 0.6,
                delay: FORM_DELAY,
                ease: [0.16, 1, 0.3, 1]
              }}
            >
              <WaitlistForm variant="hero" />
            </motion.div>

            <motion.p
              className="text-xs text-muted/60 font-mono-accent uppercase tracking-widest"
              initial={{ opacity: 0 }}
              animate={isInView ? { opacity: 1 } : undefined}
              transition={{ duration: 0.6, delay: BENEFITS_DELAY }}
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
