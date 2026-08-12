import { motion, useReducedMotion } from 'motion/react'
import { Container } from '@/components/layout/Container'
import { DownloadCTA } from '@/components/shared/DownloadCTA'

const EASE = [0.16, 1, 0.3, 1] as const

/**
 * The four anxious tabs. Each starts scattered (its own drift offset) and
 * settles into one quiet row — the product thesis, told once, in 1.5s.
 */
const SCATTERED_TABS = [
  { label: 'Notes app', x: -46, y: -26, rotate: -7 },
  { label: 'To-do list', x: -14, y: 22, rotate: 4 },
  { label: 'Calendar', x: 18, y: -20, rotate: -3 },
  { label: 'Journal', x: 48, y: 18, rotate: 6 }
] as const

const TRUST_FACTS = [
  'Open source, AGPL-3.0',
  'End-to-end encrypted',
  'No account needed',
  'Plain Markdown files'
] as const

function SettlingTabs() {
  const reduceMotion = useReducedMotion()

  return (
    <motion.div
      className="relative mx-auto inline-flex items-center gap-1.5 rounded-full border px-3 py-2"
      initial={reduceMotion ? false : { borderColor: 'rgba(0 0 0 / 0)' }}
      animate={{ borderColor: 'var(--color-border)' }}
      transition={{ delay: 1.15, duration: 0.6 }}
      aria-label="Notes app, to-do list, calendar, and journal — settled into one place"
    >
      <motion.span
        aria-hidden
        className="me-1 h-1.5 w-1.5 shrink-0 rounded-full bg-terracotta"
        initial={reduceMotion ? false : { opacity: 0, scale: 0 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 1.35, duration: 0.4, ease: EASE }}
      />
      {SCATTERED_TABS.map((tab, i) => (
        <motion.span
          key={tab.label}
          className="whitespace-nowrap rounded-full bg-paper-alt px-2 py-1 font-mono-accent text-[10px] uppercase tracking-[0.1em] text-muted sm:px-2.5 sm:tracking-[0.14em]"
          initial={reduceMotion ? false : { x: tab.x, y: tab.y, rotate: tab.rotate, opacity: 0 }}
          animate={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
          transition={{
            delay: 0.25 + i * 0.12,
            type: 'spring',
            stiffness: 170,
            damping: 22,
            opacity: { delay: 0.25 + i * 0.12, duration: 0.3 }
          }}
        >
          {tab.label}
        </motion.span>
      ))}
    </motion.div>
  )
}

/** React Bits–style blur reveal, one soft pass per line. */
function BlurLine({ children, delay }: { children: React.ReactNode; delay: number }) {
  return (
    <motion.span
      className="block"
      initial={{ opacity: 0, y: 14, filter: 'blur(10px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.9, delay, ease: EASE }}
    >
      {children}
    </motion.span>
  )
}

export function Hero() {
  return (
    <section id="hero" className="pt-32 pb-10 md:pt-40 md:pb-14">
      <Container>
        <div className="text-center">
          <SettlingTabs />

          <h1 className="display-hero mx-auto mt-8 max-w-4xl text-ink text-balance">
            <BlurLine delay={0.5}>Your thoughts,</BlurLine>
            <BlurLine delay={0.68}>
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
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.7, delay: 1.4, ease: [0.65, 0, 0.35, 1] }}
                  />
                </svg>
              </span>
            </BlurLine>
          </h1>

          <motion.p
            className="mx-auto mt-7 max-w-xl text-base leading-relaxed text-muted md:text-lg"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.95, ease: EASE }}
          >
            MemryNote is a desktop app for notes, tasks, journal, and calendar — stored on your
            machine, encrypted before it syncs, working offline all day.
          </motion.p>

          <motion.div
            className="mt-9"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 1.1, ease: EASE }}
          >
            <DownloadCTA location="hero" />
          </motion.div>

          <motion.p
            className="mt-9 font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted/70"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 1.3 }}
          >
            {TRUST_FACTS.map((fact, i) => (
              <span key={fact} className="inline-block">
                {fact}
                {i < TRUST_FACTS.length - 1 && (
                  <span aria-hidden className="mx-3 text-terracotta/60">
                    ·
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
