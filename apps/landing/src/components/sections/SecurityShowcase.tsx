import { useEffect, useRef, useState } from 'react'
import { motion, useInView, useReducedMotion } from 'motion/react'
import { Link } from 'react-router'
import { Container } from '@/components/layout/Container'

const EASE = [0.16, 1, 0.3, 1] as const

const CLEAR_TEXT_LINES = [
  'Dear diary,',
  'Today I finally figured out',
  'the perfect recipe for',
  'Sunday morning pancakes...'
]

const CIPHER_CHARS = '0123456789abcdef'

const SLOW_INTERVAL = 800
const FAST_INTERVAL = 50

function useScramble(trigger: boolean, lineCount: number, charsPerLine: number) {
  const [lines, setLines] = useState<string[]>(() => Array.from({ length: lineCount }, () => ''))
  const [hovered, setHovered] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval>>(null)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (!trigger) return

    function scramble() {
      setLines(
        Array.from({ length: lineCount }, () =>
          Array.from(
            { length: charsPerLine },
            () => CIPHER_CHARS[Math.floor(Math.random() * CIPHER_CHARS.length)]
          ).join('')
        )
      )
    }

    scramble()
    // Reduced motion: one static cipher fill, no flicker loop.
    if (reduceMotion) return
    intervalRef.current = setInterval(scramble, hovered ? FAST_INTERVAL : SLOW_INTERVAL)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [trigger, lineCount, charsPerLine, hovered, reduceMotion])

  return { lines, setHovered }
}

const PILLARS = [
  {
    title: 'Zero-knowledge sync',
    desc: 'Notes are encrypted on your machine before upload. We never hold your keys.'
  },
  {
    title: 'Plain files, yours',
    desc: 'Markdown on your own disk. Open your vault in any editor, leave any time.'
  },
  {
    title: 'Open source',
    desc: 'AGPL-3.0 licensed. Every line of the app is public — audit it yourself.'
  }
]

export function SecurityShowcase() {
  const ref = useRef<HTMLElement>(null)
  const isInView = useInView(ref, { once: true, amount: 0.3 })
  // Live (not once): the cipher ticker pauses when the section scrolls away.
  const scrambleActive = useInView(ref, { amount: 0.2 })
  const { lines: scrambled, setHovered } = useScramble(scrambleActive, 4, 28)

  return (
    <section ref={ref} className="zone-dark py-24 md:py-32">
      <Container size="md">
        <motion.div
          className="mb-14 max-w-2xl"
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : undefined}
          transition={{ duration: 0.8, ease: EASE }}
        >
          <p className="font-mono-accent text-[11px] uppercase tracking-[0.2em] text-terracotta">
            Privacy
          </p>
          <h2 className="display-section mt-4 text-ink-inverted!">
            Sealed before it <em className="text-terracotta">leaves your device.</em>
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-dark-muted">
            Sync ships only ciphertext — XChaCha20-Poly1305, keys derived on your machine. What you
            write stays between you and your devices.
          </p>
        </motion.div>

        <motion.div
          className="mb-16 grid gap-5 md:grid-cols-2"
          initial={{ opacity: 0, y: 28 }}
          animate={isInView ? { opacity: 1, y: 0 } : undefined}
          transition={{ duration: 0.8, delay: 0.15, ease: EASE }}
        >
          <div className="rounded-lg border border-dark-border bg-dark-surface p-6">
            <span className="mb-4 inline-block font-mono-accent text-[11px] uppercase tracking-[0.18em] text-sage">
              What you write
            </span>
            <div className="space-y-1 font-serif text-lg leading-relaxed text-ink-inverted">
              {CLEAR_TEXT_LINES.map((line, i) => (
                <motion.p
                  key={line}
                  initial={{ opacity: 0 }}
                  animate={isInView ? { opacity: 1 } : undefined}
                  transition={{ delay: 0.45 + i * 0.12, duration: 0.5 }}
                >
                  {line}
                </motion.p>
              ))}
            </div>
          </div>

          <div
            className="cursor-crosshair overflow-hidden rounded-lg border border-dark-border bg-dark-surface p-6 transition-colors duration-300 hover:border-terracotta/40"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            <span className="mb-4 inline-block font-mono-accent text-[11px] uppercase tracking-[0.18em] text-terracotta">
              What our server stores
            </span>
            <div className="select-none space-y-1 font-mono text-lg leading-relaxed text-terracotta/60">
              {scrambled.map((line, i) => (
                <p key={i} aria-hidden="true">
                  {line}
                </p>
              ))}
            </div>
          </div>
        </motion.div>

        <motion.div
          className="grid gap-10 border-t border-dark-border pt-12 sm:grid-cols-3"
          initial="hidden"
          animate={isInView ? 'show' : 'hidden'}
          variants={{
            hidden: {},
            show: { transition: { staggerChildren: 0.12, delayChildren: 0.4 } }
          }}
        >
          {PILLARS.map(({ title, desc }) => (
            <motion.div
              key={title}
              variants={{
                hidden: { opacity: 0, y: 16 },
                show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } }
              }}
            >
              <h3 className="font-serif text-xl text-ink-inverted">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-dark-muted">{desc}</p>
            </motion.div>
          ))}
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : undefined}
          transition={{ delay: 0.8, duration: 0.6 }}
          className="mt-12"
        >
          <Link
            to="/security"
            className="inline-flex items-center gap-2 text-sm font-medium text-terracotta transition-colors hover:text-terracotta-glow"
          >
            Read the security architecture
            <span aria-hidden>&rarr;</span>
          </Link>
        </motion.div>
      </Container>
    </section>
  )
}
