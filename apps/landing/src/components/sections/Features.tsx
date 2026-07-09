import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { FEATURES } from '@/lib/constants'
import { getFeatureScreenshotSrc } from '@/lib/feature-screenshots'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'

const EASE = [0.16, 1, 0.3, 1] as const

type Feature = (typeof FEATURES)[number]

function ModuleRow({
  feature,
  active,
  onSelect
}: {
  feature: Feature
  active: boolean
  onSelect: () => void
}) {
  const Icon = feature.icon
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
        <Icon
          className={cn(
            'h-[18px] w-[18px] shrink-0 transition-colors',
            active ? 'text-terracotta' : 'text-muted/60'
          )}
          aria-hidden
        />
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
  const { theme } = useTheme()
  const activeFeature = FEATURES.find((f) => f.id === activeId) ?? FEATURES[0]
  const screenshotSrc = getFeatureScreenshotSrc(activeFeature.screenshot, theme)

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

          <div className="overflow-hidden rounded-lg border border-border/70 bg-card shadow-card lg:sticky lg:top-28">
            {/* Materialize, don't just fade: incoming screenshot resolves from blur+scale
                over the outgoing one — no mode="wait" blank frame between panels. */}
            <div className="relative aspect-[1232/870]">
              <AnimatePresence initial={false}>
                <motion.img
                  key={`${activeFeature.id}-${theme}`}
                  src={screenshotSrc}
                  alt={`${activeFeature.title} in MemryNote`}
                  width={1232}
                  height={870}
                  decoding="async"
                  className="absolute inset-0 h-full w-full object-cover"
                  initial={{ opacity: 0, scale: 1.02, filter: 'blur(8px)' }}
                  animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, transition: { duration: 0.3, ease: 'easeOut' } }}
                  transition={{ duration: 0.5, ease: EASE }}
                />
              </AnimatePresence>
            </div>
          </div>
        </motion.div>
      </Container>
    </section>
  )
}
