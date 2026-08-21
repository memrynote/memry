import { useEffect, useRef, useState } from 'react'
import { motion, useInView, useReducedMotion } from 'motion/react'
import { Link } from 'react-router'
import { Container } from '@/components/layout/Container'

const EASE = [0.16, 1, 0.3, 1] as const

const RISE_INITIAL = { opacity: 0, y: 24 }
const RISE_ANIMATE = { opacity: 1, y: 0 }
const RISE_VIEWPORT = { once: true, margin: '-80px' } as const

const CLEAR_TEXT_LINES = [
  'Dear diary,',
  'Today I finally figured out',
  'the perfect recipe for',
  'Sunday morning pancakes...'
]

const CIPHER_CHARS = '0123456789abcdef'

const SLOW_INTERVAL = 800
const FAST_INTERVAL = 50

/** Live cipher ticker — flickers hex while in view, faster on hover, static under reduced motion. */
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

const LIST_VARIANTS = {
  hidden: {},
  show: { transition: { staggerChildren: 0.12 } }
}

const ITEM_VARIANTS = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } }
}

/**
 * Privacy — the cinematic dark break in an otherwise warm page. The clear diary
 * text you write sits beside the hex ciphertext our server actually stores, then
 * three quiet pillars close it out. Dark palette (zone-dark) kept for gravitas;
 * rhythm, motion and card language follow the home2 redesign.
 */
export function PrivacyShowcase() {
  const ref = useRef<HTMLElement>(null)
  // Live (not once): the cipher ticker pauses when the section scrolls away.
  const scrambleActive = useInView(ref, { amount: 0.2 })
  const { lines: scrambled, setHovered } = useScramble(scrambleActive, 4, 28)

  return (
    <section ref={ref} className="page-rails zone-dark px-4 py-20 sm:px-6 md:py-28">
      <Container size="md">
        <motion.div
          className="mb-12 max-w-2xl md:mb-14"
          initial={RISE_INITIAL}
          whileInView={RISE_ANIMATE}
          viewport={RISE_VIEWPORT}
          transition={{ duration: 0.8, ease: EASE }}
        >
          <p className="mb-4 font-mono-accent text-[11px] uppercase tracking-[0.2em] text-terracotta">
            Privacy
          </p>
          <h2 className="display-section text-ink-inverted! text-balance">
            Sealed before it <em className="text-terracotta">leaves your device.</em>
          </h2>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-dark-muted md:text-lg">
            Sync ships only ciphertext: XChaCha20-Poly1305, keys derived on your machine. What you
            write stays between you and your devices.
          </p>
        </motion.div>

        <div className="mb-10 grid gap-5 md:grid-cols-2">
          <motion.div
            className="rounded-2xl border border-dark-border bg-dark-surface p-6 shadow-sm sm:p-7"
            initial="hidden"
            whileInView="show"
            viewport={RISE_VIEWPORT}
            variants={LIST_VARIANTS}
          >
            <span className="mb-4 inline-block font-mono-accent text-[11px] uppercase tracking-[0.18em] text-sage">
              What you write
            </span>
            <div className="space-y-1 font-serif text-lg leading-relaxed text-ink-inverted">
              {CLEAR_TEXT_LINES.map((line) => (
                <motion.p key={line} variants={ITEM_VARIANTS}>
                  {line}
                </motion.p>
              ))}
            </div>
          </motion.div>

          <motion.div
            className="cursor-crosshair overflow-hidden rounded-2xl border border-dark-border bg-dark-surface p-6 shadow-sm transition-colors duration-300 hover:border-terracotta/40 sm:p-7"
            initial={RISE_INITIAL}
            whileInView={RISE_ANIMATE}
            viewport={RISE_VIEWPORT}
            transition={{ duration: 0.7, delay: 0.1, ease: EASE }}
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
          </motion.div>
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={RISE_VIEWPORT}
          transition={{ delay: 0.2, duration: 0.6 }}
          className="mt-2"
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
