import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Check, Minus, X } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { Button } from '@/components/ui/button'
import { ALTERNATIVES, type AltCell, type AlternativeConfig } from '@/lib/alternatives'

const REVEAL = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] as const }
}

function CellIcon({ value }: { value: AltCell }) {
  if (value === true) {
    return <Check className="mx-auto h-4 w-4 text-sage" strokeWidth={2.5} aria-label="Yes" />
  }
  if (value === 'partial') {
    return (
      <Minus className="mx-auto h-4 w-4 text-terracotta" strokeWidth={2.5} aria-label="Partial" />
    )
  }
  return <X className="mx-auto h-4 w-4 text-muted/40" strokeWidth={2} aria-label="No" />
}

function MobileValue({ value }: { value: AltCell }) {
  if (value === true) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-sage">
        <Check className="h-3.5 w-3.5" /> Yes
      </span>
    )
  }
  if (value === 'partial') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-terracotta">
        <Minus className="h-3.5 w-3.5" /> Partial
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted/70">
      <X className="h-3.5 w-3.5" /> No
    </span>
  )
}

function AlternativePage({ config }: { config: AlternativeConfig }) {
  return (
    <>
      <PageHead page={config.pageKey} />

      <section className="pt-28 pb-12 md:pt-36 md:pb-16">
        <Container size="md">
          <motion.div {...REVEAL} className="max-w-3xl">
            <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
              {config.eyebrow}
            </p>
            <h1 className="mt-4 font-serif text-4xl leading-[1.08] text-ink text-balance md:text-5xl">
              {config.heading}{' '}
              <span className="italic text-terracotta">{config.headingAccent}</span>
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">{config.intro}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link to="/download/desktop">Download memrynote</Link>
              </Button>
              <Button asChild size="lg" variant="secondary">
                <Link to="/pricing">See pricing</Link>
              </Button>
            </div>
          </motion.div>
        </Container>
      </section>

      <section className="py-16 zone-transition">
        <Container size="md">
          <motion.h2 {...REVEAL} className="display-section text-ink">
            memrynote vs <span className="italic text-terracotta">{config.competitor}</span>
          </motion.h2>

          <motion.div {...REVEAL} className="mt-10 hidden md:block">
            <table className="w-full">
              <thead>
                <tr className="border-b border-ink/15">
                  <th className="px-4 py-5 text-start font-mono-accent text-[11px] font-medium uppercase tracking-[0.18em] text-muted">
                    Feature
                  </th>
                  <th className="bg-terracotta/[0.05] px-4 py-5 text-center font-serif text-lg font-normal italic text-terracotta">
                    memrynote
                  </th>
                  <th className="px-4 py-5 text-center font-serif text-lg font-normal text-ink/80">
                    {config.competitor}
                  </th>
                </tr>
              </thead>
              <tbody>
                {config.rows.map((row) => (
                  <tr
                    key={row.feature}
                    className="border-b border-ink/10 transition-colors hover:bg-paper-alt/60"
                  >
                    <td className="px-4 py-4 font-serif text-base text-ink">{row.feature}</td>
                    <td className="bg-terracotta/[0.05] px-4 py-4">
                      <CellIcon value={row.memry} />
                    </td>
                    <td className="px-4 py-4">
                      <CellIcon value={row.competitor} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </motion.div>

          <div className="mt-8 space-y-3 md:hidden">
            {config.rows.map((row) => (
              <article key={row.feature} className="border-b border-ink/10 pb-4">
                <h3 className="font-serif text-base leading-snug text-ink">{row.feature}</h3>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="flex min-h-11 items-center justify-between gap-3 rounded-sm border border-terracotta/30 bg-terracotta/5 px-3 py-2">
                    <span className="text-xs font-medium italic text-terracotta">memrynote</span>
                    <MobileValue value={row.memry} />
                  </div>
                  <div className="flex min-h-11 items-center justify-between gap-3 rounded-sm border border-border/50 bg-paper/60 px-3 py-2">
                    <span className="text-xs font-medium text-muted">{config.competitor}</span>
                    <MobileValue value={row.competitor} />
                  </div>
                </div>
              </article>
            ))}
          </div>

          <p className="mx-auto mt-8 max-w-2xl text-xs leading-relaxed text-muted/60">
            {config.footnote}
          </p>
        </Container>
      </section>

      <section className="py-16">
        <Container size="md">
          <div className="grid gap-8 sm:grid-cols-2">
            {config.reasons.map((reason) => (
              <motion.div key={reason.title} {...REVEAL}>
                <h3 className="font-serif text-xl text-ink">{reason.title}</h3>
                <p className="mt-2 leading-relaxed text-muted">{reason.body}</p>
              </motion.div>
            ))}
          </div>
        </Container>
      </section>

      <section className="py-20 zone-transition">
        <Container size="md">
          <motion.div {...REVEAL} className="text-center">
            <h2 className="display-section text-ink">
              Make the <span className="italic text-terracotta">switch.</span>
            </h2>
            <p className="mx-auto mt-4 max-w-md text-lg leading-relaxed text-muted">
              Notes, tasks, calendar, and journal in one local-first app — private by design, open
              at heart.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Button asChild size="lg">
                <Link to="/download/desktop">Download memrynote</Link>
              </Button>
              <Button asChild size="lg" variant="secondary">
                <Link to={`/features`}>Explore features</Link>
              </Button>
            </div>
          </motion.div>
        </Container>
      </section>
    </>
  )
}

const byKey = (key: AlternativeConfig['pageKey']): AlternativeConfig => {
  const config = ALTERNATIVES.find((c) => c.pageKey === key)
  if (!config) throw new Error(`Missing alternative config: ${key}`)
  return config
}

export function ObsidianAlternativePage() {
  return <AlternativePage config={byKey('obsidianAlternative')} />
}

export function NotionAlternativePage() {
  return <AlternativePage config={byKey('notionAlternative')} />
}

export function NotePlanAlternativePage() {
  return <AlternativePage config={byKey('noteplanAlternative')} />
}
