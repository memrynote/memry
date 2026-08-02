import { motion } from 'framer-motion'
import { Link } from 'react-router'
import { Mascot } from '@/components/ui/mascot'
import { cn } from '@/lib/utils'
import { TINT_CLASSES, type MegaCardTint } from '@/lib/site-tints'
import { HomeSection, SectionTitle } from '@/components/site/primitives'

const EASE = [0.16, 1, 0.3, 1] as const

interface Persona {
  name: string
  line: string
  tint: MegaCardTint
  mascot: string
}

const PERSONAS: Persona[] = [
  {
    name: 'Writer',
    line: 'Drafts, research, and journals — all in one quiet place.',
    tint: 'sky',
    mascot: '/mascots/journal.png'
  },
  {
    name: 'Maker',
    line: 'Projects, tasks, and changelogs right beside the work.',
    tint: 'sage',
    mascot: '/mascots/maker.png'
  },
  {
    name: 'Student',
    line: 'Course notes and deadlines that stay in one place.',
    tint: 'sand',
    mascot: '/mascots/student.png'
  },
  {
    name: 'ADHD brain',
    line: 'One inbox for everything. Zero app-switching.',
    tint: 'peach',
    mascot: '/mascots/adhd-brain.png'
  },
  {
    name: 'Researcher',
    line: 'Linked notes and a graph that connects the ideas.',
    tint: 'sky',
    mascot: '/mascots/researchers.png'
  },
  {
    name: 'Privacy-first',
    line: 'End-to-end encrypted. Works offline. Yours.',
    tint: 'sage',
    mascot: '/mascots/privacy-first.png'
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
                <Mascot src={persona.mascot} className="h-16 w-16" />
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
