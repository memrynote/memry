import { useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { FEATURES } from '@/lib/constants'
import { getFeatureScreenshotSrc } from '@/lib/feature-screenshots'
import { cn } from '@/lib/utils'
import { Mascot } from '@/components/ui/mascot'

const EASE = [0.16, 1, 0.3, 1] as const

type Feature = (typeof FEATURES)[number]

/**
 * Each module wears its hand-drawn mascot on a soft tint tile drawn from the
 * home2 palette, so the row reads as the same crafted family as the rest of the
 * page — ink-on-paper in light, the recolored variant in dark.
 */
const MODULE_ICONS: Record<Feature['id'], { src: string; tile: string }> = {
  inbox: { src: '/mascots/inbox.png', tile: 'bg-tint-sky' },
  journal: { src: '/mascots/journal.png', tile: 'bg-tint-sand' },
  notes: { src: '/mascots/notes.png', tile: 'bg-tint-sage' },
  tasks: { src: '/mascots/tasks.png', tile: 'bg-tint-peach' },
  calendar: { src: '/mascots/calendar.png', tile: 'bg-tint-sky' }
}

// Each module's screenshot is matted on a fixed canvas in its own tint.
const MODULE_TINT: Record<Feature['id'], string> = {
  inbox: '--color-tint-sky',
  journal: '--color-tint-sand',
  notes: '--color-tint-sage',
  tasks: '--color-tint-peach',
  calendar: '--color-tint-lilac'
}

function ModuleRow({
  feature,
  active,
  onSelect
}: {
  feature: Feature
  active: boolean
  onSelect: () => void
}) {
  const iconCfg = MODULE_ICONS[feature.id]
  const panelId = `module-panel-${feature.id}`

  return (
    <div className="border-b border-border/60 last:border-0">
      <button
        type="button"
        id={`module-tab-${feature.id}`}
        role="tab"
        aria-selected={active}
        aria-controls={panelId}
        onClick={onSelect}
        className={cn(
          'group flex w-full items-center gap-3.5 py-4 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40',
          active ? 'text-ink' : 'text-muted hover:text-ink'
        )}
      >
        <span
          aria-hidden
          className={cn(
            'h-6 w-0.5 shrink-0 rounded-full transition-colors',
            active ? 'bg-terracotta' : 'bg-transparent group-hover:bg-border'
          )}
        />
        <span
          aria-hidden
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-xl shadow-card transition-all duration-300',
            iconCfg.tile,
            active ? 'opacity-100' : 'opacity-60 group-hover:opacity-85'
          )}
        >
          <Mascot src={iconCfg.src} className="size-8" />
        </span>
        <span className="font-serif text-xl">{feature.title}</span>
        <span className="ms-auto hidden font-serif text-sm italic text-muted/70 sm:block">
          {feature.tagline}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {active && (
          <motion.div
            id={panelId}
            role="tabpanel"
            aria-labelledby={`module-tab-${feature.id}`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="pb-5 ps-[2.35rem]">
              <p className="max-w-md text-sm leading-relaxed text-muted">{feature.description}</p>
              <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
                {feature.highlights.map((highlight) => (
                  <li key={highlight} className="text-[13px] text-ink/75">
                    {highlight}
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function Features() {
  const [activeId, setActiveId] = useState<Feature['id']>(FEATURES[0].id)
  const activeFeature = FEATURES.find((f) => f.id === activeId) ?? FEATURES[0]
  const activeIndex = FEATURES.findIndex((f) => f.id === activeId)
  const screenshotSrc = getFeatureScreenshotSrc(activeFeature.screenshot)
  const tintVar = MODULE_TINT[activeFeature.id]

  // Cycle through modules with the arrows over the screenshot (wraps around).
  const goToOffset = (offset: -1 | 1) => {
    const next = (activeIndex + offset + FEATURES.length) % FEATURES.length
    setActiveId(FEATURES[next].id)
  }

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
          <p className="mt-4 text-lg leading-relaxed text-muted">
            Each module is a room, not another tab. Open the ones that help you — and switch the
            rest off in settings.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.8, delay: 0.1, ease: EASE }}
          className="mt-12 grid items-start gap-10 lg:grid-cols-[minmax(320px,2fr)_3fr] lg:gap-14"
        >
          <div role="tablist" aria-label="MemryNote modules" aria-orientation="vertical">
            {FEATURES.map((feature) => (
              <ModuleRow
                key={feature.id}
                feature={feature}
                active={feature.id === activeId}
                onSelect={() => setActiveId(feature.id)}
              />
            ))}
          </div>

          <div
            className="relative aspect-[1328/1048] overflow-hidden rounded-xl shadow-card transition-colors duration-500 lg:sticky lg:top-28"
            style={{ backgroundColor: `var(${tintVar})` }}
          >
            {/* 1328/1048 is the canvas the five captures used to add up to back when they were
                all exported at the same scale — the widest by the tallest. Sizing by fit rather
                than by raw pixels keeps that framing whatever scale a shot gets re-exported at:
                each one fills the canvas on its long axis and mats the short one in the module's
                tint. Incoming shot resolves from blur+scale over the outgoing one — no
                mode="wait" blank frame between panels. */}
            <AnimatePresence initial={false}>
              <motion.img
                key={activeFeature.id}
                src={screenshotSrc}
                alt={`${activeFeature.title} in MemryNote`}
                decoding="async"
                className="absolute inset-0 size-full object-contain"
                initial={{ opacity: 0, scale: 1.02, filter: 'blur(8px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, transition: { duration: 0.3, ease: 'easeOut' } }}
                transition={{ duration: 0.5, ease: EASE }}
              />
            </AnimatePresence>

            {/* Prev / next arrows — a second way to move between modules, over the shot */}
            <button
              type="button"
              onClick={() => goToOffset(-1)}
              aria-label={`Previous module (${FEATURES[(activeIndex - 1 + FEATURES.length) % FEATURES.length].title})`}
              className="absolute start-3 top-1/2 z-10 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-border/60 bg-card/85 text-ink/70 shadow-card backdrop-blur-sm transition-colors hover:bg-card hover:text-terracotta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
            >
              <ChevronLeft className="size-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => goToOffset(1)}
              aria-label={`Next module (${FEATURES[(activeIndex + 1) % FEATURES.length].title})`}
              className="absolute end-3 top-1/2 z-10 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-border/60 bg-card/85 text-ink/70 shadow-card backdrop-blur-sm transition-colors hover:bg-card hover:text-terracotta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
            >
              <ChevronRight className="size-5" aria-hidden />
            </button>
          </div>
        </motion.div>
      </Container>
    </section>
  )
}
