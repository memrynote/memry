import { motion } from 'motion/react'
import { Mascot } from '@/components/ui/mascot'
import { FeatureChip, HomeSection, SectionTitle } from '@/components/site/primitives'

const EASE = [0.16, 1, 0.3, 1] as const

const THINGS = [
  { label: 'Notes', href: '/features/notes', iconSrc: '/mascots/notes.png' },
  { label: 'Tasks', href: '/features/tasks', iconSrc: '/mascots/tasks.png' },
  { label: 'Journal', href: '/features/journal', iconSrc: '/mascots/journal.png' },
  { label: 'Calendar', href: '/features/calendar', iconSrc: '/mascots/calendar.png' },
  { label: 'Inbox', href: '/features/inbox', iconSrc: '/mascots/inbox.png' },
  { label: 'AI Agent', href: '/features/ai-agent', iconSrc: '/mascots/ai-agent.png' }
] as const

/**
 * "One calm place" row — centered one-line statement followed by five small
 * feature chips linking to the feature pages.
 */
export function EverythingRow() {
  return (
    <HomeSection id="everything">
      <SectionTitle
        className="mb-8 md:mb-10"
        titleClassName="max-w-5xl"
        title={
          <>
            One calm place for all <em className="italic text-terracotta">your</em> things.
          </>
        }
      />

      <ul className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-3 px-2 sm:gap-4">
        {THINGS.map((thing, i) => (
          <motion.li
            key={thing.label}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.6, delay: i * 0.07, ease: EASE }}
          >
            <FeatureChip
              label={thing.label}
              href={thing.href}
              icon={<Mascot src={thing.iconSrc} className="h-8 w-8" />}
            />
          </motion.li>
        ))}
      </ul>
    </HomeSection>
  )
}
