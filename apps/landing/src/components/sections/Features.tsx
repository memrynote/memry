import { useRef, useLayoutEffect, useState } from 'react'
import { motion, useScroll, useTransform } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { SectionHeading } from '@/components/shared/SectionHeading'
import { FEATURES } from '@/lib/constants'
import { getFeatureScreenshotSrc } from '@/lib/feature-screenshots'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'

const STACKED_FEATURES = FEATURES.slice(0, 5)

const STICKY_OFFSET_PX = 112

const FEATURE_ACCENTS = [
  'border-terracotta/35 bg-terracotta/10 text-terracotta',
  'border-sage/35 bg-sage/10 text-sage',
  'border-ink/15 bg-ink/10 text-ink dark:border-white/15 dark:bg-white/10 dark:text-ink',
  'border-brand-400/35 bg-brand-400/10 text-brand-600 dark:text-brand-300',
  'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300'
] as const

type Feature = (typeof FEATURES)[number]

function FeatureStackCard({
  feature,
  index,
  total
}: {
  feature: Feature
  index: number
  total: number
}) {
  const Icon = feature.icon
  const accent = FEATURE_ACCENTS[index % FEATURE_ACCENTS.length]
  const isLast = index === total - 1
  const imageFirstOnDesktop = index % 2 === 1
  const articleRef = useRef<HTMLElement>(null)
  const [layout, setLayout] = useState({ nextOffsetTop: 0, cardHeight: 540 })
  const { theme } = useTheme()
  const screenshotSrc = getFeatureScreenshotSrc(feature.screenshot, theme)

  useLayoutEffect(() => {
    if (isLast) return
    const absTop = (el: HTMLElement) => {
      let top = 0
      let cur: HTMLElement | null = el
      while (cur) {
        top += cur.offsetTop
        cur = cur.offsetParent as HTMLElement | null
      }
      return top
    }
    const measure = () => {
      const article = articleRef.current
      const parent = article?.parentElement
      const next = parent?.children[index + 1] as HTMLElement | undefined
      if (article && next) {
        setLayout({ nextOffsetTop: absTop(next), cardHeight: article.offsetHeight })
      }
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [index, isLast])

  const { scrollY } = useScroll()
  const fadeProgress = useTransform(scrollY, (sY) => {
    if (isLast || !layout.nextOffsetTop) return 0
    const nextNaturalTop = layout.nextOffsetTop - sY
    const distance = nextNaturalTop - STICKY_OFFSET_PX
    return Math.max(0, Math.min(1, 1 - distance / layout.cardHeight))
  })

  const targetScale = 1 - (total - index - 1) * 0.04
  const scale = useTransform(fadeProgress, [0, 1], [1, isLast ? 1 : targetScale])
  const filter = useTransform(fadeProgress, (t) => {
    if (isLast) return 'none'
    return `blur(${t * 6}px) brightness(${1 - t * 0.55}) opacity(${1 - t * 0.95})`
  })

  return (
    <motion.article
      ref={articleRef}
      className="relative md:sticky md:top-28"
      style={{ zIndex: index + 1, scale, filter }}
    >
      <div className="group relative overflow-hidden rounded-2xl border border-border/70 bg-card shadow-elevated">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-terracotta/50 to-transparent" />

        <div
          className={cn(
            'grid min-h-[560px] md:min-h-[540px]',
            imageFirstOnDesktop ? 'md:grid-cols-[1.42fr_0.58fr]' : 'md:grid-cols-[0.58fr_1.42fr]'
          )}
        >
          <div
            className={cn(
              'order-2 flex flex-col justify-between gap-8 p-6 sm:p-8 md:p-8 lg:p-10',
              imageFirstOnDesktop ? 'md:order-2' : 'md:order-1'
            )}
          >
            <div>
              <div className="mb-8 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      'flex h-10 w-10 items-center justify-center rounded-full border',
                      accent
                    )}
                  >
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="font-mono-accent text-xs uppercase tracking-[0.18em] text-muted/60">
                    {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
                  </span>
                </div>
                <span className="hidden rounded-full border border-border/70 px-3 py-1 text-xs font-medium text-muted md:inline-flex">
                  {index === 0 ? 'Start here' : 'Then'}
                </span>
              </div>

              <h3 className="font-serif text-4xl leading-none text-ink sm:text-5xl">
                {feature.title}
              </h3>

              <p className="mt-5 max-w-sm font-serif text-2xl italic leading-tight text-terracotta">
                {feature.tagline}
              </p>

              <p className="mt-6 max-w-md text-base leading-7 text-muted sm:text-lg">
                {feature.description}
              </p>
            </div>

            <ul className="grid gap-3 sm:grid-cols-2">
              {feature.highlights.map((highlight) => (
                <li
                  key={highlight}
                  className="flex items-start gap-3 text-sm font-medium text-ink/80"
                >
                  <span className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-terracotta" />
                  {highlight}
                </li>
              ))}
            </ul>
          </div>

          <div
            className={cn(
              'relative order-1 min-h-[260px] overflow-hidden bg-paper-deep md:min-h-full',
              imageFirstOnDesktop ? 'md:order-1' : 'md:order-2'
            )}
          >
            <img
              src={screenshotSrc}
              alt={`${feature.title} feature screenshot`}
              className="h-full w-full object-cover object-left-top transition-transform duration-700 ease-out group-hover:scale-[1.025]"
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/20 via-transparent to-white/10" />
            <div
              className={cn(
                'pointer-events-none absolute inset-y-0 hidden w-16 from-card to-transparent md:block',
                imageFirstOnDesktop ? 'end-0 bg-gradient-to-l' : 'start-0 bg-gradient-to-r'
              )}
            />
          </div>
        </div>
      </div>
    </motion.article>
  )
}

export function Features() {
  return (
    <section id="features" className="py-24">
      <Container>
        <SectionHeading
          title="What's inside"
          subtitle="Everything you need to capture, organize, and act on your ideas. Nothing you don't."
          titleClassName="section-heading-medium"
        />

        <div className="relative mt-16 space-y-6 md:space-y-8">
          {STACKED_FEATURES.map((feature, index) => (
            <FeatureStackCard
              key={feature.id}
              feature={feature}
              index={index}
              total={STACKED_FEATURES.length}
            />
          ))}
        </div>
      </Container>
    </section>
  )
}
