import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { HERO_TINT_CLASSES, type HeroTint } from '@/lib/site-tints'

const EASE = [0.16, 1, 0.3, 1] as const

// One synchronized entrance, mirroring Hero2: every layer materializes together
// rather than staggering in.
const HERO_IN = { duration: 0.7, delay: 0.1, ease: EASE }

export interface PageHeroProps {
  /** Omit for an untinted hero: no panel colour, no border, the page ground shows through. */
  tint?: HeroTint
  /** ReactNode, not string: Download's kicker carries an icon. */
  eyebrow?: ReactNode
  title: ReactNode
  sub?: ReactNode
  /** CTA / pill-link slot, laid out as a centered wrapping row. */
  actions?: ReactNode
  /** Optional screenshot, mock or card row, sitting below the copy inside the panel. */
  visual?: ReactNode
  className?: string
}

/**
 * The sub-page hero: the same inset rounded mega-panel as the homepage, in a flat tint
 * instead of the painted landscape. The wallpaper stays exclusive to Hero2 — repeating
 * it across sixteen pages would strip the homepage of its entrance and ship a ~2MB
 * background on every route.
 *
 * Top padding is deliberately shorter than Hero2's (pt-24/md:pt-32 vs pt-28/md:pt-40):
 * home is the entrance and stays tallest; sub-pages reach their content faster. It still
 * clears the fixed nav pill, which floats over the panel.
 *
 * The site is light-only, so `ink` is the one dark surface in the palette — the CLI
 * page's terminal hero, and nothing else.
 */
export function PageHero({ tint, eyebrow, title, sub, actions, visual, className }: PageHeroProps) {
  const isInk = tint === 'ink'

  return (
    <section className="px-3 pb-4 pt-3 sm:px-6 md:pb-6">
      <div
        className={cn(
          'relative mx-auto w-full overflow-hidden rounded-3xl pb-8 md:pb-14',
          // Untinted: the panel keeps its geometry but drops colour and border, so the
          // page's own paper, dot grid and grain run straight through the hero.
          tint && 'border',
          tint && (isInk ? 'border-dark-border' : 'border-ink/5'),
          tint && HERO_TINT_CLASSES[tint],
          className
        )}
      >
        <div className="relative z-10 px-6 pt-24 text-center sm:px-10 md:pt-32">
          {eyebrow && (
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={HERO_IN}
              className={cn(
                'mb-4 inline-flex items-center justify-center gap-2 font-mono-accent text-[11px] uppercase tracking-[0.2em]',
                isInk ? 'text-terracotta-glow' : 'text-terracotta'
              )}
            >
              {eyebrow}
            </motion.p>
          )}

          <motion.h1
            initial={{ opacity: 0, y: 18, filter: 'blur(10px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={HERO_IN}
            className={cn(
              'display-hero mx-auto max-w-4xl text-balance',
              isInk ? 'text-ink-inverted' : 'text-ink'
            )}
          >
            {title}
          </motion.h1>

          {sub && (
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={HERO_IN}
              className={cn(
                'mx-auto mt-6 max-w-2xl text-base leading-relaxed md:text-lg',
                isInk ? 'text-dark-muted' : 'text-muted'
              )}
            >
              {sub}
            </motion.p>
          )}

          {actions && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={HERO_IN}
              className="mt-9 flex flex-wrap items-center justify-center gap-3"
            >
              {actions}
            </motion.div>
          )}
        </div>

        {visual && (
          <motion.div
            initial={{ opacity: 0, y: 72 }}
            animate={{ opacity: 1, y: 0 }}
            transition={HERO_IN}
            className="relative z-10 mx-auto mt-12 w-4/5 max-w-[57.6rem] md:mt-16"
          >
            {visual}
          </motion.div>
        )}
      </div>
    </section>
  )
}
