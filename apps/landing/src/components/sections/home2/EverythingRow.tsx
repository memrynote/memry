import { motion } from 'framer-motion'
import { Inbox } from 'lucide-react'
import { FeatureChip, HomeSection, SectionTitle } from '@/components/sections/home2/primitives'

const EASE = [0.16, 1, 0.3, 1] as const

const THINGS = [
  { label: 'Notes', href: '/features/notes', iconSrc: '/icons/icon-notes.png' },
  { label: 'Tasks', href: '/features/tasks', iconSrc: '/icons/icon-tasks.png' },
  { label: 'Journal', href: '/features/journal', iconSrc: '/icons/icon-jots.png' },
  { label: 'Calendar', href: '/features/calendar', iconSrc: '/icons/icon-calendar.png' },
  { label: 'Inbox', href: '/features/inbox', iconSrc: null }
] as const

/**
 * "Not one thing" row — centered two-line statement followed by five small
 * feature chips linking to the feature pages.
 */
export function EverythingRow() {
  return (
    <HomeSection id="everything">
      <SectionTitle
        className="mb-8 md:mb-10"
        title={
          <>
            <span className="block">MemryNote isn't just for one thing —</span>
            <span className="block">
              it's for <em className="italic text-terracotta">your</em> things.
            </span>
          </>
        }
      />

      <ul className="mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-3 px-2 sm:gap-4">
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
              icon={
                thing.iconSrc ? (
                  <img
                    src={thing.iconSrc}
                    alt=""
                    className="h-6 w-6 object-contain"
                    loading="lazy"
                  />
                ) : (
                  <Inbox className="h-5 w-5 text-terracotta" strokeWidth={1.8} />
                )
              }
            />
          </motion.li>
        ))}
      </ul>
    </HomeSection>
  )
}
