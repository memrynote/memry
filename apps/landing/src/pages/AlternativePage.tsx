import { Link } from 'react-router'
import { motion } from 'framer-motion'
import { Check, Minus, Plus, X } from 'lucide-react'
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
      <PageHead page={config.pageKey} faqs={config.faqs} />

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

      <section className="py-16 zone-transition">
        <Container size="md">
          <div className="mx-auto max-w-3xl space-y-12">
            {config.sections.map((section) => (
              <motion.div key={section.heading} {...REVEAL}>
                <h2 className="font-serif text-2xl text-ink md:text-3xl">{section.heading}</h2>
                <p className="mt-4 text-lg leading-relaxed text-muted">{section.body}</p>
              </motion.div>
            ))}
          </div>
        </Container>
      </section>

      <section className="py-16">
        <Container size="md">
          <motion.h2 {...REVEAL} className="display-section text-ink">
            Pricing: memrynote vs{' '}
            <span className="italic text-terracotta">{config.competitor}</span>
          </motion.h2>
          <motion.div {...REVEAL} className="mt-10 grid gap-4 sm:grid-cols-2">
            <div className="rounded-sm border border-terracotta/30 bg-terracotta/5 p-6">
              <p className="font-serif text-lg italic text-terracotta">memrynote</p>
              <p className="mt-2 leading-relaxed text-ink">{config.pricing.memry}</p>
            </div>
            <div className="rounded-sm border border-border/60 bg-paper/60 p-6">
              <p className="font-serif text-lg text-ink/80">{config.competitor}</p>
              <p className="mt-2 leading-relaxed text-muted">{config.pricing.competitor}</p>
            </div>
          </motion.div>
        </Container>
      </section>

      <section className="py-16">
        <Container size="md">
          <motion.div {...REVEAL} className="mx-auto max-w-3xl">
            <h2 className="display-section text-ink">
              Switch from <span className="italic text-terracotta">{config.competitor}</span>
            </h2>
            <ol className="mt-8 space-y-4">
              {config.migration.steps.map((step, i) => (
                <li key={step} className="flex gap-4">
                  <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-terracotta/10 font-mono-accent text-xs text-terracotta">
                    {i + 1}
                  </span>
                  <p className="leading-relaxed text-muted">{step}</p>
                </li>
              ))}
            </ol>
            {config.migration.importer && (
              <p className="mt-6 text-sm leading-relaxed text-muted/70">
                memrynote includes a built-in {config.migration.importer} importer in Settings →
                Import.
              </p>
            )}
          </motion.div>
        </Container>
      </section>

      <section className="py-16 zone-transition">
        <Container size="md">
          <motion.h2 {...REVEAL} className="display-section text-ink">
            {config.competitor} alternative <span className="italic text-terracotta">FAQ</span>
          </motion.h2>
          <div className="mx-auto mt-10 max-w-3xl divide-y divide-ink/10">
            {config.faqs.map((faq) => (
              <details key={faq.question} className="group py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-serif text-lg text-ink">
                  {faq.question}
                  <Plus className="h-4 w-4 flex-none text-terracotta transition-transform group-open:rotate-45" />
                </summary>
                <p className="mt-3 leading-relaxed text-muted">{faq.answer}</p>
              </details>
            ))}
          </div>
        </Container>
      </section>

      <section className="py-20">
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

export function CapacitiesAlternativePage() {
  return <AlternativePage config={byKey('capacitiesAlternative')} />
}

export function EvernoteAlternativePage() {
  return <AlternativePage config={byKey('evernoteAlternative')} />
}

export function LogseqAlternativePage() {
  return <AlternativePage config={byKey('logseqAlternative')} />
}

export function AnytypeAlternativePage() {
  return <AlternativePage config={byKey('anytypeAlternative')} />
}

export function AppleNotesAlternativePage() {
  return <AlternativePage config={byKey('appleNotesAlternative')} />
}

export function BearAlternativePage() {
  return <AlternativePage config={byKey('bearAlternative')} />
}

export function RoamAlternativePage() {
  return <AlternativePage config={byKey('roamAlternative')} />
}

export function OneNoteAlternativePage() {
  return <AlternativePage config={byKey('onenoteAlternative')} />
}

export function UpNoteAlternativePage() {
  return <AlternativePage config={byKey('upnoteAlternative')} />
}

export function JoplinAlternativePage() {
  return <AlternativePage config={byKey('joplinAlternative')} />
}

export function GoogleKeepAlternativePage() {
  return <AlternativePage config={byKey('googleKeepAlternative')} />
}

export function TanaAlternativePage() {
  return <AlternativePage config={byKey('tanaAlternative')} />
}

export function HeptabaseAlternativePage() {
  return <AlternativePage config={byKey('heptabaseAlternative')} />
}
