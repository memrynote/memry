import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'
import {
  HomeSection,
  SectionTitle,
  type MegaCardTint
} from '@/components/sections/home2/primitives'

const EASE = [0.16, 1, 0.3, 1] as const

const TINT_CLASSES: Record<MegaCardTint, string> = {
  sky: 'bg-tint-sky',
  sage: 'bg-tint-sage',
  sand: 'bg-tint-sand',
  peach: 'bg-tint-peach'
}

/** Shared frame for the hand-drawn-feel persona glyphs. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 48 48"
      className="h-10 w-10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

interface Persona {
  name: string
  line: string
  tint: MegaCardTint
  glyph: ReactNode
}

const PERSONAS: Persona[] = [
  {
    name: 'Writer',
    line: 'Drafts, research, and journals — all in one quiet place.',
    tint: 'sky',
    glyph: (
      <Glyph>
        <path d="M38 10c-10 2-19 9-23 18l-3 10 10-3c9-4 16-13 18-23z" />
        <path d="M13 35l8-8" />
      </Glyph>
    )
  },
  {
    name: 'Maker',
    line: 'Projects, tasks, and changelogs right beside the work.',
    tint: 'sage',
    glyph: (
      <Glyph>
        <rect x="17" y="10" width="14" height="12" rx="3" />
        <rect x="8" y="26" width="14" height="12" rx="3" />
        <rect x="26" y="26" width="14" height="12" rx="3" />
      </Glyph>
    )
  },
  {
    name: 'Student',
    line: 'Course notes and deadlines that stay in one place.',
    tint: 'sand',
    glyph: (
      <Glyph>
        <path d="M24 10 6 19l18 9 18-9-18-9z" />
        <path d="M14 24v8c0 2.5 5 4.5 10 4.5s10-2 10-4.5v-8" />
        <path d="M42 19v9" />
      </Glyph>
    )
  },
  {
    name: 'ADHD brain',
    line: 'One inbox for everything. Zero app-switching.',
    tint: 'peach',
    glyph: (
      <Glyph>
        <path d="M6 28c2-9 5 9 8 0s5 8 8 0 5 5 8 2c4-3 8-4 12-4" />
      </Glyph>
    )
  },
  {
    name: 'Researcher',
    line: 'Linked notes and a graph that connects the ideas.',
    tint: 'sky',
    glyph: (
      <Glyph>
        <circle cx="13" cy="14" r="4.5" />
        <circle cx="35" cy="11" r="4.5" />
        <circle cx="24" cy="36" r="4.5" />
        <path d="M17.5 13.5l13-2" />
        <path d="M15 18l7 14" />
        <path d="M33 15l-7 17" />
      </Glyph>
    )
  },
  {
    name: 'Privacy-first',
    line: 'End-to-end encrypted. Works offline. Yours.',
    tint: 'sage',
    glyph: (
      <Glyph>
        <rect x="13" y="22" width="22" height="16" rx="4" />
        <path d="M18 22v-5a6 6 0 0 1 12 0v5" />
        <path d="M24 28.5v3" />
      </Glyph>
    )
  }
]

/**
 * "How people use it" — horizontal snap-scroll gallery of persona cards on
 * alternating pastel tints. Every card links to /use-cases.
 */
export function UseCasesGallery() {
  return (
    <HomeSection id="use-cases">
      <SectionTitle
        eyebrow="How people use it"
        title="One app, many kinds of minds"
        sub="One calm place, set up your way."
      />

      <div
        className={cn(
          '-mx-4 snap-x snap-mandatory overflow-x-auto pb-4 sm:-mx-6',
          'scroll-ps-4 sm:scroll-ps-6',
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        )}
        aria-label="How people use MemryNote"
      >
        <ul className="mx-auto flex w-max gap-4 px-4 sm:gap-5 sm:px-6">
          {PERSONAS.map((persona, i) => (
            <motion.li
              key={persona.name}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ duration: 0.7, delay: i * 0.06, ease: EASE }}
              className="w-64 shrink-0 snap-start sm:w-72"
            >
              <Link
                to="/use-cases"
                className={cn(
                  'flex h-full flex-col gap-5 rounded-3xl border border-ink/5 p-6',
                  'transition-all duration-300 ease-out hover:-translate-y-1 hover:shadow-card',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta',
                  TINT_CLASSES[persona.tint]
                )}
              >
                <span aria-hidden className="text-terracotta">
                  {persona.glyph}
                </span>
                <span>
                  <span className="block text-lg font-semibold text-ink">{persona.name}</span>
                  <span className="mt-1.5 block text-sm leading-relaxed text-muted">
                    {persona.line}
                  </span>
                </span>
              </Link>
            </motion.li>
          ))}
        </ul>
      </div>
    </HomeSection>
  )
}
