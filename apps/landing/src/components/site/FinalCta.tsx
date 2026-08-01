import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DownloadButton } from '@/components/shared/DownloadCTA'
import { trackLandingEvent } from '@/lib/analytics'
import { cn } from '@/lib/utils'
import { HomeSection } from '@/components/site/primitives'

const EASE = [0.16, 1, 0.3, 1] as const

// Faint concentric rings, outer → inner. Each blooms in behind the rising sun.
const SUN_ARCS = [
  { d: 'M150 240a210 210 0 0 1 420 0', o: 0.12 },
  { d: 'M203 240a157 157 0 0 1 314 0', o: 0.2 },
  { d: 'M256 240a104 104 0 0 1 208 0', o: 0.3 }
] as const

const SUN_VIEWPORT = { once: true, margin: '-80px' } as const

/**
 * Terracotta sunrise — concentric arcs over a half-sun that RISES from the banner's
 * bottom edge as the closer scrolls into view: the sunrise metaphor the surrounding
 * copy names, made literal at the one emotional beat of the page. Motion is
 * transform/opacity only; the card's `overflow-hidden` clips the sun's start below the
 * baseline. Framer-motion runs on rAF, so the global reduced-motion CSS does not touch
 * it — `useReducedMotion()` renders every element settled instead.
 */
function SunArc() {
  const reduce = useReducedMotion()

  return (
    <svg
      viewBox="0 0 720 240"
      preserveAspectRatio="xMidYMax meet"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-40 w-full md:h-52"
      aria-hidden
    >
      <g fill="none" stroke="#ff671a">
        {SUN_ARCS.map((arc, i) => (
          <motion.path
            key={arc.d}
            d={arc.d}
            strokeOpacity={arc.o}
            strokeWidth="2"
            initial={reduce ? false : { opacity: 0, y: 12 }}
            whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
            viewport={SUN_VIEWPORT}
            transition={reduce ? undefined : { duration: 0.7, delay: 0.15 + i * 0.08, ease: EASE }}
          />
        ))}
      </g>
      <motion.path
        d="M308 240a52 52 0 0 1 104 0Z"
        fill="#ff671a"
        fillOpacity="0.85"
        initial={reduce ? false : { opacity: 0, y: 26 }}
        whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
        viewport={SUN_VIEWPORT}
        transition={reduce ? undefined : { duration: 0.9, delay: 0.28, ease: EASE }}
      />
    </svg>
  )
}

export interface FinalCtaSecondary {
  label: string
  to: string
  /** trackLandingEvent detail, e.g. `pricing:home-final`. */
  event: string
}

export interface FinalCtaProps {
  title: ReactNode
  sub?: ReactNode
  /** Analytics location passed to DownloadButton, e.g. `home-final`. */
  location: string
  /** Optional ghost link beside the download button. */
  secondary?: FinalCtaSecondary
  /** Small print under the buttons — Pricing carries its merchant-of-record line here. */
  footnote?: ReactNode
  className?: string
}

/**
 * The site's closing banner: a dark sunrise card that ends every page the same way.
 *
 * This is the homepage's closer generalized — every other page hand-rolled a plainer
 * version of it (`py-24 bg-paper-alt` + an h2 + DownloadCTA), which is precisely the
 * drift this layer exists to end. The dark surface is deliberate: it is the one moment
 * the light site goes quiet before the ask.
 */
export function FinalCta({ title, sub, location, secondary, footnote, className }: FinalCtaProps) {
  return (
    <HomeSection>
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.8, ease: EASE }}
        className={cn(
          'zone-dark relative mx-auto w-full max-w-6xl overflow-hidden rounded-3xl border border-white/10',
          'px-6 pt-16 pb-40 text-center sm:px-10 md:pt-24 md:pb-52',
          className
        )}
      >
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(circle at 50% 100%, rgb(255 103 26 / 0.12), transparent 55%)'
          }}
          aria-hidden
        />
        <SunArc />

        <div className="relative">
          <h2 className="font-serif text-5xl text-ink-inverted text-balance md:text-6xl">
            {title}
          </h2>
          {sub && (
            <p className="mx-auto mt-6 max-w-md text-lg leading-relaxed text-dark-muted">{sub}</p>
          )}

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <DownloadButton location={location} />
            {secondary && (
              <Button
                size="lg"
                variant="ghost"
                className="rounded-full px-6 text-ink-inverted hover:bg-white/10"
                asChild
              >
                <Link
                  to={secondary.to}
                  onClick={() => trackLandingEvent('landing_nav_click', secondary.event)}
                >
                  {secondary.label}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            )}
          </div>

          {footnote && (
            <p className="mt-12 font-mono-accent text-[10px] uppercase tracking-[0.3em] text-dark-muted/70">
              {footnote}
            </p>
          )}
        </div>
      </motion.div>
    </HomeSection>
  )
}
