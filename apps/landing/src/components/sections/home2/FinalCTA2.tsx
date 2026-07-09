import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DownloadButton } from '@/components/shared/DownloadCTA'
import { trackLandingEvent } from '@/lib/analytics'
import { HomeSection } from '@/components/sections/home2/primitives'

const EASE = [0.16, 1, 0.3, 1] as const

/** Terracotta sunrise — concentric arcs over a half-sun rising from the banner's bottom edge. */
function SunArc() {
  return (
    <svg
      viewBox="0 0 720 240"
      preserveAspectRatio="xMidYMax meet"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-40 w-full md:h-52"
      aria-hidden
    >
      <g fill="none" stroke="#ff671a">
        <path d="M150 240a210 210 0 0 1 420 0" strokeOpacity="0.12" strokeWidth="2" />
        <path d="M203 240a157 157 0 0 1 314 0" strokeOpacity="0.2" strokeWidth="2" />
        <path d="M256 240a104 104 0 0 1 208 0" strokeOpacity="0.3" strokeWidth="2" />
      </g>
      <path d="M308 240a52 52 0 0 1 104 0Z" fill="#ff671a" fillOpacity="0.85" />
    </svg>
  )
}

export function FinalCTA2() {
  return (
    <HomeSection>
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.8, ease: EASE }}
        className="zone-dark relative mx-auto w-full max-w-6xl overflow-hidden rounded-3xl border border-white/10 px-6 pt-16 pb-40 text-center sm:px-10 md:pt-24 md:pb-52"
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
            Let&rsquo;s get <em className="text-terracotta">started</em>
          </h2>
          <p className="mx-auto mt-6 max-w-md text-lg leading-relaxed text-dark-muted">
            Free to start. Private by default. Yours forever.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <DownloadButton location="home-final" />
            <Button
              size="lg"
              variant="ghost"
              className="rounded-full px-6 text-ink-inverted hover:bg-white/10"
              asChild
            >
              <Link
                to="/pricing"
                onClick={() => trackLandingEvent('landing_nav_click', 'pricing:home-final')}
              >
                See pricing
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </motion.div>
    </HomeSection>
  )
}
