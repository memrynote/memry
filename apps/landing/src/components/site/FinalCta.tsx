import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { DownloadPill } from '@/components/shared/DownloadCTA'
import { trackLandingEvent } from '@/lib/analytics'
import { cn } from '@/lib/utils'

const EASE = [0.16, 1, 0.3, 1] as const

/**
 * Two washes over the tinted ground, straight from the Paper `getstarted` frame: a soft
 * accent bloom centred on the panel, and a white lift over the top half so the mark and
 * the slogan sit on near-paper while the edges stay tinted.
 */
const CTA_WASH =
  'radial-gradient(circle at 50% 50%, rgb(255 103 26 / 0.10), transparent 62%),' +
  ' radial-gradient(circle at 50% 25%, rgb(255 255 255 / 0.92), transparent 45%)'

export interface FinalCtaSecondary {
  label: string
  to: string
  /** trackLandingEvent detail, e.g. `pricing:home-final`. */
  event: string
}

export interface FinalCtaProps {
  title: ReactNode
  sub?: ReactNode
  /** Analytics location passed to DownloadPill, e.g. `home-final`. */
  location: string
  /** Optional ghost link beside the download button. */
  secondary?: FinalCtaSecondary
  /** Small print under the buttons — Pricing carries its merchant-of-record line here. */
  footnote?: ReactNode
  className?: string
}

/**
 * The site's closing banner: the mark, the slogan, and the same download pill the hero
 * opens with — every page ends on the one ask, on a light panel rather than a dark one.
 */
export function FinalCta({ title, sub, location, secondary, footnote, className }: FinalCtaProps) {
  return (
    <section>
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.8, ease: EASE }}
        className={cn(
          'relative w-full overflow-hidden bg-tint-sky',
          'px-6 pb-24 pt-20 text-center sm:px-10 md:pb-32 md:pt-28',
          className
        )}
      >
        <div className="pointer-events-none absolute inset-0" style={{ background: CTA_WASH }} />

        {/* The page's dot grid + grain, same as the hero: the panel lays its own colour
            over the page ground, so the texture is repainted on top of it. */}
        <div aria-hidden className="page-texture pointer-events-none absolute inset-0" />

        <div className="relative">
          <img
            src="/favicon.svg"
            alt=""
            aria-hidden
            width={119}
            height={96}
            className="mx-auto mb-3 h-24 w-auto"
          />

          {/* Same type geometry as the hero headline — 42px cap, -0.055em tracking, 112%
              leading. The base h2 rule in index.css is unlayered, so leading and tracking
              need the important modifier to win over it. */}
          <h2 className="mx-auto max-w-[18ch] font-serif text-[42px] font-normal leading-[112%]! tracking-[-0.055em]! text-ink text-balance">
            {title}
          </h2>

          {sub && (
            <p className="mx-auto mt-5 max-w-md text-base leading-relaxed text-muted">{sub}</p>
          )}

          <div className="mt-11 flex flex-col items-center justify-center gap-4 sm:flex-row sm:gap-[30px]">
            <DownloadPill location={location} />
            {secondary && (
              <Link
                to={secondary.to}
                onClick={() => trackLandingEvent('landing_nav_click', secondary.event)}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[14px] px-4 text-[14px] font-medium leading-[18px] text-ink transition-colors duration-200 hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
              >
                {secondary.label}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            )}
          </div>

          {footnote && (
            <p className="mt-12 font-mono-accent text-[10px] uppercase tracking-[0.3em] text-muted/70">
              {footnote}
            </p>
          )}
        </div>
      </motion.div>
    </section>
  )
}
