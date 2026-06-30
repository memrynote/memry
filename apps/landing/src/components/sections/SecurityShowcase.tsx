import { useEffect, useRef, useState } from 'react'
import { motion, useInView } from 'framer-motion'
import { Shield, FolderOpen, Eye } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { Link } from 'react-router-dom'

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
    intervalRef.current = setInterval(scramble, hovered ? FAST_INTERVAL : SLOW_INTERVAL)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [trigger, lineCount, charsPerLine, hovered])

  return { lines, setHovered }
}

const PILLARS = [
  {
    icon: Shield,
    title: 'Zero-knowledge',
    desc: 'We never see your decryption keys. Not even if we wanted to.'
  },
  {
    icon: FolderOpen,
    title: 'Local-first',
    desc: 'Plain .md files on your device. No vendor lock-in, ever.'
  },
  {
    icon: Eye,
    title: 'Open source',
    desc: 'AGPL-3.0 licensed. Read every line. Audit it yourself.'
  }
]

export function SecurityShowcase() {
  const ref = useRef<HTMLElement>(null)
  const isInView = useInView(ref, { once: true, amount: 0.3 })
  const { lines: scrambled, setHovered } = useScramble(isInView, 4, 28)

  return (
    <section ref={ref} className="zone-dark py-24 md:py-32">
      <Container>
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 24 }}
          animate={isInView ? { opacity: 1, y: 0 } : undefined}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          <p className="mb-4 font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
            § 04 — Sealed
          </p>
          <h2 className="display-section text-ink-inverted mb-4">
            We can't read your notes. <span className="text-terracotta italic">By design.</span>
          </h2>
          <p className="text-lg text-dark-muted font-sans max-w-xl mx-auto">
            End-to-end encrypted with XChaCha20-Poly1305. Your words are sealed before they ever
            leave your device.
          </p>
        </motion.div>

        <motion.div
          className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto mb-20"
          initial={{ opacity: 0, y: 32 }}
          animate={isInView ? { opacity: 1, y: 0 } : undefined}
          transition={{ duration: 0.8, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="rounded-lg border border-dark-border bg-dark-surface p-6">
            <span className="inline-block text-xs font-mono-accent uppercase tracking-widest text-sage mb-4">
              Plate I — What you see
            </span>
            <div className="font-serif text-lg text-ink-inverted leading-relaxed space-y-1">
              {CLEAR_TEXT_LINES.map((line, i) => (
                <motion.p
                  key={line}
                  initial={{ opacity: 0 }}
                  animate={isInView ? { opacity: 1 } : undefined}
                  transition={{ delay: 0.5 + i * 0.12, duration: 0.5 }}
                >
                  {line}
                </motion.p>
              ))}
            </div>
          </div>

          <div
            className="rounded-lg border border-dark-border bg-dark-surface p-6 overflow-hidden cursor-crosshair transition-border-color duration-300 hover:border-terracotta/40"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            <span className="inline-block text-xs font-mono-accent uppercase tracking-widest text-terracotta mb-4">
              Plate II — What we see
            </span>
            <div className="font-mono text-lg text-terracotta/60 leading-relaxed space-y-1 select-none">
              {scrambled.map((line, i) => (
                <p key={i} aria-hidden="true">
                  {line}
                </p>
              ))}
            </div>
          </div>
        </motion.div>

        <motion.div
          className="grid sm:grid-cols-3 gap-8 max-w-3xl mx-auto mb-12"
          initial="hidden"
          animate={isInView ? 'show' : 'hidden'}
          variants={{
            hidden: {},
            show: { transition: { staggerChildren: 0.12, delayChildren: 0.5 } }
          }}
        >
          {PILLARS.map(({ icon: Icon, title, desc }) => (
            <motion.div
              key={title}
              className="text-center"
              variants={{
                hidden: { opacity: 0, y: 20 },
                show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] } }
              }}
            >
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-full border border-sage/30 mb-3">
                <Icon className="w-5 h-5 text-sage" />
              </div>
              <h3 className="font-serif text-xl text-ink-inverted mb-2">{title}</h3>
              <p className="text-sm text-dark-muted leading-relaxed">{desc}</p>
            </motion.div>
          ))}
        </motion.div>

        <motion.div
          className="text-center"
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : undefined}
          transition={{ delay: 0.9, duration: 0.6 }}
        >
          <Link
            to="/security"
            className="inline-flex items-center gap-2 text-sm font-mono-accent uppercase tracking-widest text-terracotta hover:text-terracotta-dark transition-colors"
          >
            Read our security architecture
            <span aria-hidden="true">&rarr;</span>
          </Link>
        </motion.div>
      </Container>
    </section>
  )
}
