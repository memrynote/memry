import { useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, Play } from 'lucide-react'
import { Link } from 'react-router-dom'
import heroBg from '@/assets/hero-bg.png'
import paperLeft from '@/assets/paper-left.png'
import paperRight from '@/assets/paper-right.png'
import { Button } from '@/components/ui/button'
import { Mascot } from '@/components/ui/mascot'
import { DownloadButton } from '@/components/shared/DownloadCTA'
import { HeroDemoDialog } from '@/components/site/HeroDemoDialog'
import { trackLandingEvent } from '@/lib/analytics'

const EASE = [0.16, 1, 0.3, 1] as const

// One synchronized entrance — every hero layer (copy, CTAs, papers, screenshot)
// shares this transition so the whole hero materializes at once, not in a stagger.
const HERO_IN = { duration: 0.7, delay: 0.1, ease: EASE }

const HERO_SHOT = { src: '/screenshots/hero_white.png', width: 1445, height: 952 } as const

/**
 * Sticker chip inside the hero headline — hand-drawn mascot + italic word on a
 * pastel pill. Everything is em-sized so the chip scales with display-hero's
 * clamp()ed font size. The mascot is ink-on-transparent (paper shows through),
 * so it sits straight on the pill — no color tile. Its empty alt keeps it
 * decorative, so screen readers hear the plain sentence.
 */
function HeadlineChip({
  mascotSrc,
  pillClassName,
  children
}: {
  mascotSrc: string
  pillClassName: string
  children: React.ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center gap-[0.12em] whitespace-nowrap rounded-[0.32em] border border-ink/5 ps-[0.16em] pe-[0.26em] py-[0.08em] align-middle shadow-card ${pillClassName}`}
    >
      <Mascot src={mascotSrc} className="size-[0.95em] shrink-0" />
      <span className="italic">{children}</span>
    </span>
  )
}

export function Hero2() {
  const shot = HERO_SHOT
  const [demoOpen, setDemoOpen] = useState(false)

  return (
    <section id="hero" className="px-3 pb-4 pt-3 sm:px-6 md:pb-6">
      {/* The illustrated sky mega-panel — rounded, inset from the viewport edges.
          Top inset matches the nav's pt-3 so the fixed nav pill floats over the wallpaper.
          No height cap: the panel takes its natural content height, so on laptop screens
          it fills the viewport (full-screen hero) with the screenshot bleeding off the
          bottom, clipped by overflow-hidden. */}
      <div className="relative mx-auto w-full overflow-hidden rounded-3xl border border-ink/5 bg-tint-sky pb-8 md:pb-14">
        {/* Painted landscape backdrop — a whisper of blur pushes it back so the copy + app
            window read as the foreground; scale-105 hides the soft edges the blur would
            otherwise fade at the panel border. */}
        <img
          src={heroBg}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full scale-105 object-cover blur-[3px]"
        />

        {/* Copy + CTAs */}
        <div className="relative z-10 px-6 pt-28 text-center sm:px-10 md:pt-40">
          <motion.h1
            className="display-hero mx-auto max-w-4xl text-ink text-balance"
            initial={{ opacity: 0, y: 18, filter: 'blur(10px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={HERO_IN}
          >
            Your{' '}
            {/* nowrap keeps the comma glued to the pill — atomic inlines invite a wrap right after */}
            <span className="whitespace-nowrap">
              <HeadlineChip
                mascotSrc="/mascots/thoughts.png"
                pillClassName="-rotate-2 bg-tint-sky text-[#2e5a78]"
              >
                thoughts
              </HeadlineChip>
              ,
            </span>
            <br className="hidden sm:block" /> beautifully{' '}
            <HeadlineChip
              mascotSrc="/mascots/organized.png"
              pillClassName="rotate-2 bg-tint-peach text-terracotta-dark"
            >
              organized
            </HeadlineChip>
          </motion.h1>

          <motion.p
            className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted md:text-lg"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={HERO_IN}
          >
            Offline-first. End-to-end encrypted. Yours.
          </motion.p>

          <motion.div
            className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={HERO_IN}
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

        {/* Torn-paper collage peeking from behind the app window — desk / note-app vibe.
            Two halves of one sheet, each pinned to its own edge so the lined sheets hug the
            left and the yellow legal pad hugs the right. Nudged below the panel edge (negative
            bottom, clipped by overflow-hidden) so only the tops peek, behind the app window
            (z-5 < z-10). framer-motion owns `transform`, so the push-down uses `bottom`. */}
        <motion.img
          src={paperLeft}
          alt=""
          aria-hidden
          className="pointer-events-none absolute -bottom-8 start-0 z-[5] h-[170px] w-auto select-none sm:-bottom-10 sm:h-[235px] md:-bottom-14 md:h-[300px]"
          initial={{ opacity: 0, y: 44 }}
          animate={{ opacity: 1, y: 0 }}
          transition={HERO_IN}
        />
        <motion.img
          src={paperRight}
          alt=""
          aria-hidden
          className="pointer-events-none absolute -bottom-8 end-0 z-[5] h-[170px] w-auto select-none sm:-bottom-10 sm:h-[235px] md:-bottom-14 md:h-[300px]"
          initial={{ opacity: 0, y: 44 }}
          animate={{ opacity: 1, y: 0 }}
          transition={HERO_IN}
        />

        {/* App screenshot — large, flat and whole. No perspective tilt: that 3D transform
            rasterized the high-res capture soft (the "blurry" look); flat renders it crisp.
            No translate/overflow bleed either, so the full window is shown, nothing trimmed
            off the bottom — it sits warm in the sky with the papers peeking behind its base. */}
        <motion.div
          className="relative z-10 mx-auto mt-12 w-4/5 max-w-[57.6rem] md:mt-16"
          initial={{ opacity: 0, y: 72 }}
          animate={{ opacity: 1, y: 0 }}
          transition={HERO_IN}
        >
          {/* The whole window is the demo trigger — click opens the video lightbox.
              Hover lift (subtle scale + rise) rides the group here; plain 2D transform on
              the img stays crisp (no 3D raster softening) and motion-safe gates it off under
              reduced-motion. */}
          <button
            type="button"
            aria-label="Watch the MemryNote demo"
            onClick={() => {
              trackLandingEvent('landing_hero_demo_open', 'hero')
              setDemoOpen(true)
            }}
            className="group relative block w-full rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/70"
          >
            <img
              src={shot.src}
              alt="The MemryNote app showing a note with tags, a table, and tasks"
              width={shot.width}
              height={shot.height}
              loading="eager"
              decoding="async"
              className="block h-auto w-full drop-shadow-[0_24px_60px_rgba(31,41,55,0.30)] transition-transform duration-300 ease-out motion-safe:group-hover:-translate-y-2 motion-safe:group-hover:scale-[1.02]"
            />
            {/* Watch cue — hidden until hover/keyboard focus; always shown on touch (no hover). */}
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="flex translate-y-1 scale-95 items-center gap-2 rounded-full bg-ink/75 px-5 py-2.5 text-sm font-medium text-white opacity-0 shadow-[0_16px_50px_rgba(31,41,55,0.45)] backdrop-blur-md transition-all duration-200 ease-out group-hover:translate-y-0 group-hover:scale-100 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:scale-100 group-focus-visible:opacity-100 motion-reduce:transition-none [@media(hover:none)]:translate-y-0 [@media(hover:none)]:scale-100 [@media(hover:none)]:opacity-100">
                <Play className="h-4 w-4 fill-current" strokeWidth={1.6} />
                Watch demo
              </span>
            </span>
          </button>
        </motion.div>
      </div>

      <HeroDemoDialog open={demoOpen} onClose={() => setDemoOpen(false)} />
    </section>
  )
}
