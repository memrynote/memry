import {
  motion,
  AnimatePresence,
  useReducedMotion,
  useTransform,
  type MotionValue
} from 'motion/react'
import type { MouseEvent } from 'react'
import { CLIPS } from './types'
import { FLOW_STEPS } from '@/lib/constants'
import { cn } from '@/lib/utils'

/** The four watchable chapters, in playlist order. */
export const CHAPTERS = FLOW_STEPS.filter((step) => CLIPS.some((clip) => clip.id === step.id))

interface ChapterScrubberProps {
  progress: MotionValue<number>
  onSeek: (progress: number) => void
}

function ChapterScrubber({ progress, onSeek }: ChapterScrubberProps) {
  const scaleX = useTransform(progress, [0, 1], [0, 1])

  const handleClick = (event: MouseEvent<HTMLSpanElement>) => {
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    onSeek(Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1))
  }

  return (
    <span
      aria-hidden="true"
      title="Click to jump"
      onClick={handleClick}
      className="flex h-5 cursor-ew-resize items-center"
    >
      <span className="block h-1 w-full overflow-hidden rounded-full bg-border/80">
        <motion.span
          className="block h-full w-full origin-left rounded-full bg-terracotta"
          style={{ scaleX }}
        />
      </span>
    </span>
  )
}

interface ChapterRailProps {
  activeIndex: number
  playing: boolean
  progress: MotionValue<number>
  onChapterClick: (index: number) => void
  onActiveToggle: () => void
  onActiveSeek: (progress: number) => void
}

export function ChapterRail({
  activeIndex,
  playing,
  progress,
  onChapterClick,
  onActiveToggle,
  onActiveSeek
}: ChapterRailProps) {
  const reduceMotion = useReducedMotion()

  return (
    <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-col lg:gap-2.5">
      {CHAPTERS.map((step, index) => {
        const isActive = index === activeIndex
        const Icon = step.icon
        const competitorLabel = 'competitorLabel' in step ? step.competitorLabel : 'Replaces'

        return (
          <button
            key={step.id}
            type="button"
            onClick={() => (isActive ? onActiveToggle() : onChapterClick(index))}
            aria-current={isActive || undefined}
            aria-label={
              isActive
                ? `${playing ? 'Pause' : 'Play'} the ${step.title} demo`
                : `Watch the ${step.title} demo`
            }
            className={cn(
              'flex flex-col justify-center gap-1 rounded-xl border p-3.5 text-start transition-colors lg:flex-1 lg:px-4',
              isActive ? 'border-border bg-card shadow-card' : 'border-border/50 hover:bg-paper-alt'
            )}
          >
            <span className="flex items-center gap-2.5">
              <Icon
                className={cn(
                  'h-4 w-4 shrink-0 transition-colors',
                  isActive ? 'text-terracotta' : 'text-muted/70'
                )}
                strokeWidth={1.75}
              />
              <span className={cn('text-sm font-medium', isActive ? 'text-ink' : 'text-muted')}>
                {step.title}
              </span>
            </span>
            <span
              className={cn('text-[13px] leading-snug', isActive ? 'text-muted' : 'text-muted/70')}
            >
              {step.tagline}
            </span>
            <AnimatePresence initial={false}>
              {isActive && (
                <motion.span
                  className="block overflow-hidden"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{
                    duration: reduceMotion ? 0 : 0.35,
                    ease: [0.16, 1, 0.3, 1]
                  }}
                >
                  <ChapterScrubber progress={progress} onSeek={onActiveSeek} />
                  <span className="flex flex-wrap items-center gap-2 pt-0.5">
                    <span className="font-mono-accent text-[10px] uppercase tracking-wider text-muted/60">
                      {competitorLabel}
                    </span>
                    {step.competitors.map((c) => (
                      <img
                        key={c.name}
                        src={c.logo}
                        alt={c.name}
                        title={c.name}
                        width={16}
                        height={16}
                        loading="lazy"
                        decoding="async"
                        className="h-4 w-4 rounded-sm opacity-60"
                      />
                    ))}
                  </span>
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        )
      })}
    </div>
  )
}
