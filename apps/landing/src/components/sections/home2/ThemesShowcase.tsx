import { motion } from 'framer-motion'
import { HomeSection, SectionTitle } from '@/components/sections/home2/primitives'

const EASE = [0.16, 1, 0.3, 1] as const

const RISE_INITIAL = { opacity: 0, y: 24 }
const RISE_ANIMATE = { opacity: 1, y: 0 }
const RISE_VIEWPORT = { once: true, margin: '-80px' } as const

/**
 * Fixed swatch palettes — deliberately NOT theme tokens. A "Light" cover must
 * stay light even when the page is in dark mode; these are theme previews.
 */
interface ThemeSwatch {
  name: string
  bg: string
  chrome: string
  heading: string
  line: string
  accent: string
  tilt: string
}

const THEME_SWATCHES: ThemeSwatch[] = [
  {
    name: 'Light',
    bg: '#fffcf7',
    chrome: '#e8e4dd',
    heading: '#1f2937',
    line: '#ddd6cb',
    accent: '#ff671a',
    tilt: 'md:-rotate-2'
  },
  {
    name: 'Dark',
    bg: '#141210',
    chrome: '#2e2a25',
    heading: '#f5f0ea',
    line: '#3a352f',
    accent: '#ff894d',
    tilt: 'md:rotate-1'
  },
  {
    name: 'Terracotta',
    bg: '#fff0e6',
    chrome: '#ffd6bd',
    heading: '#b33c00',
    line: '#f4c4a6',
    accent: '#e64d00',
    tilt: 'md:-rotate-1'
  },
  {
    name: 'Sage',
    bg: '#eef3ec',
    chrome: '#d5e0d1',
    heading: '#33493d',
    line: '#c2d1be',
    accent: '#5b7f6a',
    tilt: 'md:rotate-2'
  },
  {
    name: 'Paper',
    bg: '#efe9df',
    chrome: '#ddd3c3',
    heading: '#4a4238',
    line: '#d2c7b4',
    accent: '#a08862',
    tilt: 'md:-rotate-1'
  }
]

const CUSTOMIZATION_FACTS = [
  'Light & dark themes',
  'Editor width: normal or full',
  'Every module is a toggle'
] as const

/** Tiny pure-CSS editor mockup — window dots, heading, body lines, two task rows. */
function ThemeSwatchCard({ swatch }: { swatch: ThemeSwatch }) {
  return (
    <figure
      className={`group m-0 flex w-32 shrink-0 snap-center flex-col items-center gap-3 sm:w-36 ${swatch.tilt}`}
    >
      <div
        aria-hidden
        className="flex aspect-[4/5] w-full flex-col rounded-2xl border border-ink/10 p-3.5 shadow-sm transition-all duration-300 ease-out group-hover:-translate-y-1.5 group-hover:shadow-card sm:p-4"
        style={{ backgroundColor: swatch.bg }}
      >
        <div className="flex gap-1">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: swatch.chrome }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: swatch.chrome }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: swatch.chrome }} />
        </div>

        <div className="mt-3 h-2 w-3/5 rounded-full" style={{ backgroundColor: swatch.heading }} />
        <div className="mt-1.5 h-1 w-8 rounded-full" style={{ backgroundColor: swatch.accent }} />

        <div className="mt-3 space-y-1.5">
          <div className="h-1.5 w-full rounded-full" style={{ backgroundColor: swatch.line }} />
          <div className="h-1.5 w-5/6 rounded-full" style={{ backgroundColor: swatch.line }} />
          <div className="h-1.5 w-4/6 rounded-full" style={{ backgroundColor: swatch.line }} />
        </div>

        <div className="mt-auto space-y-1.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[3px]" style={{ backgroundColor: swatch.accent }} />
            <span className="h-1.5 w-3/5 rounded-full" style={{ backgroundColor: swatch.line }} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[3px] border" style={{ borderColor: swatch.accent }} />
            <span className="h-1.5 w-2/5 rounded-full" style={{ backgroundColor: swatch.line }} />
          </div>
        </div>
      </div>
      <figcaption className="text-xs font-medium text-muted">{swatch.name}</figcaption>
    </figure>
  )
}

/**
 * "Make it yours" — customization section. A row of pure-CSS theme swatch
 * cards (mini editor covers), plus the real settings story: themes, editor
 * width, and per-module toggles.
 */
export function ThemesShowcase() {
  return (
    <HomeSection id="customization">
      <SectionTitle
        eyebrow="CUSTOMIZATION"
        title="Make it unmistakably yours"
        sub="Your space should look like you — and only carry what you actually use. Calendar off, AI off, your call."
      />

      <motion.div
        initial={RISE_INITIAL}
        whileInView={RISE_ANIMATE}
        viewport={RISE_VIEWPORT}
        transition={{ duration: 0.8, ease: EASE }}
        className="scrollbar-hide -mx-4 flex snap-x snap-mandatory gap-5 overflow-x-auto px-4 pt-2 pb-3 sm:-mx-6 sm:px-6 md:mx-auto md:max-w-4xl md:justify-center md:overflow-visible"
      >
        {THEME_SWATCHES.map((swatch) => (
          <ThemeSwatchCard key={swatch.name} swatch={swatch} />
        ))}
      </motion.div>

      <motion.p
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={RISE_VIEWPORT}
        transition={{ duration: 0.8, delay: 0.2, ease: EASE }}
        className="mt-10 text-center font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted/70"
      >
        {CUSTOMIZATION_FACTS.map((fact, i) => (
          <span key={fact} className="inline-block">
            {fact}
            {i < CUSTOMIZATION_FACTS.length - 1 && (
              <span aria-hidden className="mx-3 text-terracotta/60">
                ·
              </span>
            )}
          </span>
        ))}
      </motion.p>
    </HomeSection>
  )
}
