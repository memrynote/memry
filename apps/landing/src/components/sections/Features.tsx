import { useRef, useLayoutEffect, useState } from 'react'
import { motion, useScroll, useTransform } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { FEATURES } from '@/lib/constants'
import { getFeatureScreenshotSrc } from '@/lib/feature-screenshots'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'

const STACKED_FEATURES = FEATURES.slice(0, 5)

const STICKY_OFFSET_PX = 112

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
      <div className="group relative overflow-hidden rounded-lg border border-ink/15 bg-card shadow-elevated">
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
              <div className="mb-8 flex items-start justify-between gap-4">
                <span className="chapter-num" aria-hidden>
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="pt-2 font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted/60">
                  Ch. {index + 1} / {total}
                </span>
              </div>

              <h3 className="font-serif text-4xl leading-none text-ink sm:text-5xl">
                {feature.title}
              </h3>

              <p className="mt-4 max-w-sm font-serif text-2xl italic leading-tight text-terracotta">
                {feature.tagline}
              </p>

              <p className="mt-6 max-w-md text-base leading-7 text-muted">{feature.description}</p>
            </div>

            <ul className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
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
              'relative order-1 min-h-[260px] overflow-hidden bg-paper-deep md:min-h-full',
              imageFirstOnDesktop ? 'md:order-1' : 'md:order-2'
            )}
          >
            <img
              src={screenshotSrc}
              alt={`${feature.title} feature screenshot`}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover object-left-top transition-transform duration-700 ease-out group-hover:scale-[1.025]"
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/20 via-transparent to-white/10" />
            <div
              className={cn(
                'pointer-events-none absolute inset-y-0 hidden w-16 from-card to-transparent md:block',
                imageFirstOnDesktop ? 'end-0 bg-gradient-to-l' : 'start-0 bg-gradient-to-r'
              )}
            />
            <span className="pointer-events-none absolute bottom-3 end-4 font-mono-accent text-[10px] uppercase tracking-[0.2em] text-white/80 drop-shadow-sm">
              Fig. {index + 1} — {feature.title}, unedited
            </span>
          </div>
        </div>
      </div>
    </motion.article>
  )
}

export function Features() {
  return (
    <section id="features" className="py-24 md:py-32">
      <Container>
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="grid gap-6 md:grid-cols-[minmax(200px,1fr)_2fr]"
        >
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
