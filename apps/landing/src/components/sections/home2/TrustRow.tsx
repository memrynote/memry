import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { HomeSection } from '@/components/sections/home2/primitives'

const EASE = [0.16, 1, 0.3, 1] as const

interface TrustFact {
  title: string
  desc: string
  href?: string
  icon: ReactNode
}

/** Small monochrome stroke icons — quiet, hand-drawn weight, currentColor. */
const ICON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  className: 'h-5 w-5'
} as const

const FACTS: TrustFact[] = [
  {
    title: 'End-to-end encrypted',
    desc: 'XChaCha20-Poly1305. Sealed before it leaves your device.',
    href: '/security',
    icon: (
      <svg {...ICON_PROPS} aria-hidden>
        <rect x="5" y="10.5" width="14" height="9" rx="2" />
        <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
        <circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    )
  },
  {
    title: 'Offline-first',
    desc: 'Local SQLite on your machine. Sync is optional.',
    icon: (
      <svg {...ICON_PROPS} aria-hidden>
        <ellipse cx="12" cy="6.5" rx="7" ry="2.8" />
        <path d="M5 6.5v11c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8v-11" />
        <path d="M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" />
      </svg>
    )
  },
  {
    title: 'Open format',
    desc: 'Plain Markdown files. Open them anywhere, leave any time.',
    icon: (
      <svg {...ICON_PROPS} aria-hidden>
        <path d="M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z" />
        <path d="M14 3.5V8h4.5" />
        <path d="M8.5 13.5v-2.6l1.6 1.7 1.6-1.7v2.6" />
        <path d="M15 11v2.6M13.8 12.4l1.2 1.2 1.2-1.2" />
      </svg>
    )
  },
  {
    title: 'Founder-made',
    desc: 'Built by one person who uses it all day, every day.',
    icon: (
      <svg {...ICON_PROPS} aria-hidden>
        <path d="M15.6 4.9a2.1 2.1 0 0 1 3 3L8.8 17.6 4.5 19l1.4-4.3z" />
        <path d="M13.8 6.7l3 3" />
      </svg>
    )
  }
]

const LIST_VARIANTS = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1 } }
}

const TILE_VARIANTS = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } }
}

function TileBody({ fact }: { fact: TrustFact }) {
  return (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/70 bg-paper-alt text-muted">
        {fact.icon}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
          {fact.title}
          {fact.href && (
            <span
              aria-hidden
              className="text-muted/60 transition-transform duration-300 ease-out group-hover:translate-x-0.5"
            >
              &rarr;
            </span>
          )}
        </span>
        <span className="mt-1 block text-[13px] leading-relaxed text-muted">{fact.desc}</span>
      </span>
    </>
  )
}

/**
 * Trust row — four quiet fact tiles in place of an awards strip.
 * No badges, no logos: just what is true about how MemryNote is built.
 */
export function TrustRow() {
  return (
    <HomeSection>
      <motion.ul
        aria-label="Why you can trust MemryNote"
        className="mx-auto grid w-full max-w-5xl list-none grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: '-80px' }}
        variants={LIST_VARIANTS}
      >
        {FACTS.map((fact) => {
          const tileClass =
            'flex h-full items-start gap-3.5 rounded-2xl border border-border/70 bg-card p-5 shadow-sm'

          return (
            <motion.li key={fact.title} variants={TILE_VARIANTS}>
              {fact.href ? (
                <Link
                  to={fact.href}
                  className={`group ${tileClass} transition-all duration-300 ease-out hover:-translate-y-0.5 hover:shadow-card`}
                >
                  <TileBody fact={fact} />
                </Link>
              ) : (
                <div className={tileClass}>
                  <TileBody fact={fact} />
                </div>
              )}
            </motion.li>
          )
        })}
      </motion.ul>
    </HomeSection>
  )
}
