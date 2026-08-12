import { motion } from 'motion/react'
import { HomeSection, SectionTitle } from '@/components/site/primitives'
import { Mascot } from '@/components/ui/mascot'
import { cn } from '@/lib/utils'

const EASE = [0.16, 1, 0.3, 1] as const

const RISE_VIEWPORT = { once: true, margin: '-80px' } as const

interface StructureCard {
  iconSrc: string
  title: string
  description: string
  float: string
}

const STRUCTURE_CARDS: StructureCard[] = [
  {
    iconSrc: '/mascots/folder-tags.png',
    title: 'Folders & tags',
    description: 'Organize how you already think.',
    float: 'md:translate-y-5 md:-rotate-1'
  },
  {
    iconSrc: '/mascots/projects.png',
    title: 'Projects',
    description: 'Notes, tasks and deadlines in one place.',
    float: 'md:-translate-y-3'
  },
  {
    iconSrc: '/mascots/links-graph.png',
    title: 'Links & graph',
    description: 'Backlinks connect ideas for you.',
    float: 'md:translate-y-7 md:rotate-1'
  }
]

/** Soft hand-drawn-feel cloud blob — fill comes from the current text color token. */
function Cloud({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 200 80"
      className={cn('fill-current', className)}
      aria-hidden
      focusable="false"
    >
      <path d="M40 72 C 22 72 10 60 14 47 C 17 36 30 30 40 33 C 44 18 60 10 74 15 C 84 4 104 3 114 14 C 130 8 146 16 148 31 C 163 32 172 44 168 56 C 165 66 154 72 142 72 Z" />
    </svg>
  )
}

/**
 * Structure section — three floating cards (Folders & tags, Projects, Links & graph)
 * drifting among soft clouds, directly on the paper background.
 */
export function StructureShowcase() {
  return (
    <HomeSection id="structure">
      <div className="relative isolate mx-auto max-w-5xl">
        {/* Cloud layer — decorative, sits behind the cards */}
        <motion.div
          aria-hidden
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={RISE_VIEWPORT}
          transition={{ duration: 1.2, ease: EASE }}
          className="pointer-events-none absolute inset-0 -z-10"
        >
          <Cloud className="absolute -top-6 -start-8 w-36 text-tint-sky md:-start-16 md:w-56" />
          <Cloud className="absolute top-12 -end-6 w-28 text-tint-peach md:-end-14 md:w-48" />
          <Cloud className="absolute -bottom-4 start-1/3 w-32 text-tint-sand md:w-52" />
        </motion.div>

        <SectionTitle
          title={
            <>
              Structure that adapts to <em className="text-terracotta">your thinking</em>
            </>
          }
        />

        <div className="relative grid gap-5 sm:grid-cols-3 md:gap-7 md:pb-10">
          {STRUCTURE_CARDS.map((card, i) => (
            <motion.div
              key={card.title}
              initial={{ opacity: 0, y: 28 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={RISE_VIEWPORT}
              transition={{ duration: 0.8, delay: 0.1 + i * 0.12, ease: EASE }}
            >
              <div
                className={cn(
                  'flex h-full flex-col gap-4 rounded-2xl border border-border/70 bg-card p-6 shadow-card',
                  card.float
                )}
              >
                <Mascot src={card.iconSrc} className="h-14 w-14" />
                <div>
                  <h3 className="font-serif text-xl text-ink">{card.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{card.description}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </HomeSection>
  )
}
