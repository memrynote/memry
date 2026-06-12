import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { FEATURES } from '@/lib/constants'
import { getFeatureScreenshotSrc } from '@/lib/feature-screenshots'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'

type Feature = (typeof FEATURES)[number]

const REVEAL = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.8, ease: [0.16, 1, 0.3, 1] as const }
}

function FeatureChapter({ feature, index }: { feature: Feature; index: number }) {
  const imageOnStart = index % 2 === 1
  const { theme } = useTheme()
  const screenshotSrc = getFeatureScreenshotSrc(feature.screenshot, theme)

  return (
    <motion.article {...REVEAL} className="border-t border-ink/10 py-14 md:py-20">
      <div className="grid items-start gap-10 lg:grid-cols-12 lg:gap-12">
        <div
          className={cn(
            'order-2 lg:col-span-5',
            imageOnStart ? 'lg:order-2 lg:col-start-8' : 'lg:order-1'
          )}
        >
          <div className="flex items-start justify-between gap-6">
            <span className="chapter-num" aria-hidden>
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="pt-2 font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted/60">
              Ch. {index + 1} / {FEATURES.length}
            </span>
          </div>

          <h3 className="display-section mt-8 text-ink">{feature.title}</h3>

          <p className="mt-3 font-serif text-2xl italic leading-tight text-terracotta">
            {feature.tagline}
          </p>

          <p className="mt-6 max-w-md text-base leading-7 text-muted">{feature.description}</p>

          <ul className="mt-8 grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
            {feature.highlights.map((highlight) => (
              <li key={highlight} className="flex items-baseline gap-2.5 text-sm text-ink/80">
                <span aria-hidden className="font-serif text-terracotta">
                  ✳
                </span>
                {highlight}
              </li>
            ))}
          </ul>
        </div>

        <div
          className={cn(
            'order-1 lg:col-span-7',
            imageOnStart ? 'lg:order-1 lg:col-start-1 lg:row-start-1' : 'lg:order-2'
          )}
        >
          <figure
            className={cn(
              'group relative overflow-hidden rounded-lg border border-ink/15 bg-paper-deep shadow-elevated transition-transform duration-700 ease-out hover:rotate-0',
              imageOnStart ? '-rotate-[0.5deg]' : 'rotate-[0.5deg]'
            )}
          >
            <img
              src={screenshotSrc}
              alt={`${feature.title} feature screenshot`}
              loading="lazy"
              className="aspect-[16/10] w-full object-cover object-left-top transition-transform duration-700 ease-out group-hover:scale-[1.02]"
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/15 via-transparent to-transparent" />
          </figure>
          <figcaption className="mt-3 text-end font-mono-accent text-[10px] uppercase tracking-[0.2em] text-muted/50">
            Fig. {index + 1} — {feature.title}, unedited
          </figcaption>
        </div>
      </div>
    </motion.article>
  )
}

export function Features() {
  return (
    <section id="features" className="py-24 md:py-32">
      <Container>
        <motion.div {...REVEAL} className="grid gap-6 md:grid-cols-[minmax(200px,1fr)_2fr]">
          <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
            § 02 — Contents
          </p>
          <div>
            <h2 className="display-section text-ink">
              What's inside, <span className="italic text-terracotta">chapter by chapter.</span>
            </h2>
            <p className="mt-4 max-w-xl text-lg leading-relaxed text-muted">
              Everything you need to capture, organize, and act on your ideas. Nothing you don't.
            </p>
          </div>
        </motion.div>

        <div className="mt-16">
          {FEATURES.map((feature, index) => (
            <FeatureChapter key={feature.id} feature={feature} index={index} />
          ))}
        </div>
      </Container>
    </section>
  )
}
