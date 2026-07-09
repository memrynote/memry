import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { DownloadButton } from '@/components/shared/DownloadCTA'
import { trackLandingEvent } from '@/lib/analytics'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'

const EASE = [0.16, 1, 0.3, 1] as const

/**
 * The hero screenshot only exists as a light capture, so dark mode swaps to the
 * dark notes screenshot — same theme-swap pattern as FeatureHeroScreenshot.
 */
const HERO_SCREENSHOTS = {
  light: { src: '/placeholders/hero-screenshot.png', width: 1404, height: 900 },
  dark: { src: '/screenshots/note_black.png', width: 1232, height: 870 }
} as const

/** Soft hand-drawn-feel cloud that drifts very slowly. Decorative only. */
function Cloud({
  className,
  drift = -8,
  duration = 16
}: {
  className?: string
  drift?: number
  duration?: number
}) {
  return (
    <motion.svg
      viewBox="0 0 220 78"
      className={cn('pointer-events-none absolute text-white/70 dark:text-white/[0.05]', className)}
      aria-hidden
      animate={{ y: [0, drift, 0] }}
      transition={{ duration, repeat: Infinity, ease: 'easeInOut' }}
    >
      <g fill="currentColor">
        <circle cx="46" cy="50" r="22" />
        <circle cx="86" cy="36" r="30" />
        <circle cx="132" cy="42" r="26" />
        <circle cx="170" cy="52" r="18" />
        <rect x="34" y="48" width="150" height="26" rx="13" />
      </g>
    </motion.svg>
  )
}

/** Terracotta sun with dashed halo rings — a warm glow in light, a muted ember in dark. */
function Sun({ className }: { className?: string }) {
  return (
    <div className={cn('pointer-events-none absolute', className)} aria-hidden>
      <div className="absolute -inset-12 rounded-full bg-[radial-gradient(circle,rgba(255,103,26,0.22),transparent_70%)] dark:bg-[radial-gradient(circle,rgba(255,103,26,0.14),transparent_70%)]" />
      <svg viewBox="0 0 120 120" className="relative h-full w-full text-terracotta">
        <circle cx="60" cy="60" r="24" fill="currentColor" className="opacity-90 dark:opacity-75" />
        <circle
          cx="60"
          cy="60"
          r="38"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="4 10"
          strokeLinecap="round"
          className="opacity-40 dark:opacity-30"
        />
        <circle
          cx="60"
          cy="60"
          r="52"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2 14"
          strokeLinecap="round"
          className="opacity-20 dark:opacity-15"
        />
      </svg>
    </div>
  )
}

/**
 * Paper-grain hills along the bottom edge of the panel. High at the corners,
 * dipping in the middle so the screenshot rises through them. Token fills flip
 * automatically in dark mode.
 */
function Hills({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1440 190"
      preserveAspectRatio="none"
      className={cn('pointer-events-none absolute inset-x-0 bottom-0 w-full', className)}
      aria-hidden
    >
      <path
        d="M0 190 L0 96 C 160 34 330 44 470 92 C 610 140 780 150 940 118 C 1120 82 1300 56 1440 92 L1440 190 Z"
        fill="var(--color-tint-sage)"
        opacity="0.9"
      />
      <path
        d="M0 190 L0 140 C 220 84 420 96 600 142 C 760 182 900 186 1060 168 C 1220 150 1340 138 1440 148 L1440 190 Z"
        fill="var(--color-paper-deep)"
      />
      <path
        d="M0 190 L0 160 C 260 118 520 132 760 166 C 980 194 1200 188 1440 166 L1440 190 Z"
        fill="var(--color-paper-alt)"
      />
    </svg>
  )
}

export function Hero2() {
  const { theme } = useTheme()
  const shot = HERO_SCREENSHOTS[theme]

  return (
    <section id="hero" className="px-3 pb-4 pt-24 sm:px-6 md:pb-6 md:pt-32">
      {/* The illustrated sky mega-panel — rounded, inset from the viewport edges. */}
      <div className="relative mx-auto w-full max-w-7xl overflow-hidden rounded-3xl border border-ink/5 bg-gradient-to-b from-tint-sky via-tint-sky/70 to-tint-peach">
        {/* Sky scenery */}
        <Sun className="end-[6%] top-10 h-20 w-20 sm:h-24 sm:w-24 md:top-14 md:h-32 md:w-32" />
        <Cloud className="start-[4%] top-16 w-32 md:top-24 md:w-48" drift={-8} duration={17} />
        <Cloud className="end-[16%] top-44 hidden w-36 md:block" drift={-6} duration={21} />
        <Cloud
          className="start-[16%] top-64 hidden w-24 opacity-70 lg:block"
          drift={-10}
          duration={14}
        />

        {/* Copy + CTAs */}
        <div className="relative z-10 px-6 pt-16 text-center sm:px-10 md:pt-24">
          <motion.h1
            className="display-hero mx-auto max-w-4xl text-ink text-balance"
            initial={{ opacity: 0, y: 18, filter: 'blur(10px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 0.9, delay: 0.15, ease: EASE }}
          >
            One <span className="italic text-terracotta">calm</span> place for your notes, tasks,
            and big ideas
          </motion.h1>

          <motion.p
            className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted md:text-lg"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.45, ease: EASE }}
          >
            Offline-first. End-to-end encrypted. Yours.
          </motion.p>

          <motion.div
            className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.6, ease: EASE }}
          >
            <DownloadButton location="hero" />
            <Button
              size="lg"
              variant="ghost"
              className="rounded-full px-6 text-ink hover:bg-ink/5"
              asChild
            >
              <Link
                to="/pricing"
                onClick={() => trackLandingEvent('landing_nav_click', 'pricing:hero')}
              >
                See pricing
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </motion.div>
        </div>

        {/* App screenshot rising from the bottom edge, tucked behind the hills */}
        <motion.div
          className="relative z-10 mx-auto mt-12 w-full max-w-4xl px-6 sm:px-10 md:mt-16"
          initial={{ opacity: 0, y: 72 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, delay: 0.75, ease: EASE }}
        >
          <div className="translate-y-4 [transform-origin:center_bottom] md:translate-y-6">
            <div className="overflow-hidden rounded-t-[24px] border border-b-0 border-ink/10 bg-card shadow-[0_-24px_80px_-24px_rgba(31,41,55,0.4)] [transform:perspective(1600px)_rotateX(2deg)]">
              <img
                src={shot.src}
                alt="The MemryNote app showing a note with tags, a table, and tasks"
                width={shot.width}
                height={shot.height}
                loading="eager"
                decoding="async"
                className="block h-auto w-full"
              />
            </div>
          </div>
        </motion.div>

        <Hills className="z-20 h-24 sm:h-32 md:h-44" />
      </div>
    </section>
  )
}
