import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Container } from '@/components/layout/Container'
import { FEATURES } from '@/lib/constants'
import { getFeatureScreenshotSrc } from '@/lib/feature-screenshots'
import { cn } from '@/lib/utils'

const EASE = [0.16, 1, 0.3, 1] as const

type Feature = (typeof FEATURES)[number]

// Each module's screenshot is matted on a fixed canvas in its own tint.
const MODULE_TINT: Record<Feature['id'], string> = {
  inbox: '--color-tint-sky',
  journal: '--color-tint-sand',
  notes: '--color-tint-sage',
  tasks: '--color-tint-peach',
  calendar: '--color-tint-lilac'
}

function moduleDomId(id: Feature['id']) {
  return `module-${id}`
}

/**
 * Which module the reader is on. The rail is a table of contents, so "current" is the
 * last module whose heading has crossed the top third of the viewport — not whichever
 * one happens to intersect, which flips back and forth on tall panels.
 */
function useActiveModule() {
  const [activeId, setActiveId] = useState<Feature['id']>(FEATURES[0].id)
  const panelRefs = useRef(new Map<Feature['id'], HTMLElement>())

  useEffect(() => {
    const read = () => {
      const line = window.innerHeight * 0.34
      let current: Feature['id'] = FEATURES[0].id

      for (const feature of FEATURES) {
        const node = panelRefs.current.get(feature.id)
        if (node && node.getBoundingClientRect().top <= line) current = feature.id
      }

      setActiveId(current)
    }

    read()
    window.addEventListener('scroll', read, { passive: true })
    window.addEventListener('resize', read)
    return () => {
      window.removeEventListener('scroll', read)
      window.removeEventListener('resize', read)
    }
  }, [])

  // One stable callback per module — a fresh closure each render would detach and
  // re-attach every panel ref on every scroll tick.
  const setters = useRef(new Map<Feature['id'], (node: HTMLElement | null) => void>())
  const registerPanel = useCallback((id: Feature['id']) => {
    const existing = setters.current.get(id)
    if (existing) return existing

    const setter = (node: HTMLElement | null) => {
      if (node) panelRefs.current.set(id, node)
      else panelRefs.current.delete(id)
    }
    setters.current.set(id, setter)
    return setter
  }, [])

  return { activeId, registerPanel }
}

function ModulePanel({
  feature,
  panelRef
}: {
  feature: Feature
  panelRef: (node: HTMLElement | null) => void
}) {
  return (
    <section
      id={moduleDomId(feature.id)}
      ref={panelRef}
      className="scroll-mt-28 pb-16 last:pb-0 md:pb-24"
    >
      <div className="mb-6 max-w-[420px]">
        <h3 className="font-serif text-[24px] font-normal leading-[110%]! tracking-[-0.03em]! text-ink">
          {feature.title}
        </h3>
        <p className="mt-3 text-base leading-[160%] text-muted">{feature.description}</p>
      </div>

      {/* One frame for all five, at 80% of the column from lg up.

          The captures do not share an aspect ratio — 1.06 (inbox) through 1.75 (notes) —
          so `object-contain` matted each one to a different rendered size and the five
          shots read as five different windows. `object-cover` on a 4:3 frame renders every
          one at exactly the same width and height; 4:3 sits near the middle of that spread,
          so the crop is shared out rather than falling entirely on the widest shot.
          `object-top` keeps each window's title bar and toolbar, cropping from the bottom. */}
      <div
        className="relative aspect-[4/3] overflow-hidden rounded-xl shadow-card lg:w-[80%]"
        style={{ backgroundColor: `var(${MODULE_TINT[feature.id]})` }}
      >
        <img
          src={getFeatureScreenshotSrc(feature.screenshot)}
          alt={`${feature.title} in MemryNote`}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full object-cover object-top"
        />
      </div>
    </section>
  )
}

/**
 * The five modules, read top to bottom. A sticky rail of module names holds still on the
 * start edge and marks where you are; the shots scroll past it. No tabs — nothing is
 * hidden behind a click, and the page reads as one continuous tour.
 */
export function Features() {
  const { activeId, registerPanel } = useActiveModule()

  return (
    <section id="features" className="py-24 md:py-32">
      <Container>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.8, ease: EASE }}
          className="max-w-2xl"
        >
          <p className="font-mono-accent text-[11px] uppercase tracking-[0.2em] text-terracotta">
            Inside MemryNote
          </p>
          <h2 className="display-section mt-4 text-ink">
            Five modules. <em className="text-terracotta">One window.</em>
          </h2>
          <p className="section-sub mt-4">
            Each module is a room, not another tab. Open the ones that help you, and switch the rest
            off in settings.
          </p>
        </motion.div>

        <div className="mt-12 grid items-start gap-10 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-14">
          <nav
            aria-label="MemryNote modules"
            className="hidden lg:sticky lg:top-28 lg:flex lg:flex-col"
          >
            {FEATURES.map((feature) => {
              const active = feature.id === activeId

              return (
                <a
                  key={feature.id}
                  href={`#${moduleDomId(feature.id)}`}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'flex min-h-[54px] items-center border-b border-ink/10 py-3.5 text-base leading-[135%]',
                    'tracking-[-0.02em] transition-colors duration-200 last:border-0',
                    active ? 'font-medium text-ink' : 'text-muted/70 hover:text-ink'
                  )}
                >
                  {feature.title}
                </a>
              )
            })}
          </nav>

          <div>
            {FEATURES.map((feature) => (
              <ModulePanel
                key={feature.id}
                feature={feature}
                panelRef={registerPanel(feature.id)}
              />
            ))}
          </div>
        </div>
      </Container>
    </section>
  )
}
