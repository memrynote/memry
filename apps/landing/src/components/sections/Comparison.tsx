import { motion } from 'framer-motion'
import { Check, X, Minus } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { COMPARISON_DATA } from '@/lib/constants'
import { cn } from '@/lib/utils'

const REVEAL = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.8, ease: [0.16, 1, 0.3, 1] as const }
}

const comparisonColumns = [
  { key: 'memry', label: 'memrynote', featured: true },
  { key: 'notion', label: 'Notion', featured: false },
  { key: 'obsidian', label: 'Obsidian', featured: false },
  { key: 'logseq', label: 'Logseq', featured: false }
] as const

function ComparisonCell({ value }: { value: boolean | 'partial' }) {
  if (value === true) {
    return (
      <div className="flex justify-center">
        <Check className="h-4 w-4 text-sage" strokeWidth={2.5} aria-label="Yes" />
      </div>
    )
  }

  if (value === 'partial') {
    return (
      <div className="flex justify-center">
        <Minus className="h-4 w-4 text-terracotta" strokeWidth={2.5} aria-label="Partial" />
      </div>
    )
  }

  return (
    <div className="flex justify-center">
      <X className="h-4 w-4 text-muted/40" strokeWidth={2} aria-label="No" />
    </div>
  )
}

function ComparisonMobileValue({ value }: { value: boolean | 'partial' }) {
  if (value === true) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-sage">
        <Check className="h-3.5 w-3.5" />
        Yes
      </span>
    )
  }

  if (value === 'partial') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-terracotta">
        <Minus className="h-3.5 w-3.5" />
        Partial
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted/70">
      <X className="h-3.5 w-3.5" />
      No
    </span>
  )
}

export function Comparison() {
  return (
    <section className="py-24 zone-transition">
      <Container size="md">
        <motion.div {...REVEAL} className="mb-14">
          <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
            § 03 — The ledger
          </p>
          <h2 className="display-section mt-4 text-ink">
            How memrynote <span className="italic text-terracotta">compares.</span>
          </h2>
          <p className="mt-4 max-w-xl text-lg leading-relaxed text-muted">
            We built memrynote to be the PKM we wished existed.
          </p>
        </motion.div>

        <motion.div {...REVEAL} className="hidden md:block">
          <div className="rule-double text-ink/30" aria-hidden />
          <table className="w-full">
            <thead>
              <tr className="border-b border-ink/15">
                {COMPARISON_DATA.headers.map((header, index) => (
                  <th
                    key={header || 'feature'}
                    className={cn(
                      'px-4 py-5',
                      index === 0
                        ? 'text-start font-mono-accent text-[11px] font-medium uppercase tracking-[0.18em] text-muted'
                        : 'text-center font-serif text-lg font-normal',
                      index === 1 ? 'bg-terracotta/[0.05] italic text-terracotta' : 'text-ink/80'
                    )}
                  >
                    {index === 0 ? 'Feature' : header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON_DATA.rows.map((row) => (
                <tr
                  key={row.feature}
                  className="border-b border-ink/10 transition-colors hover:bg-paper-alt/60"
                >
                  <td className="px-4 py-4 font-serif text-base text-ink">{row.feature}</td>
                  <td className="bg-terracotta/[0.05] px-4 py-4">
                    <ComparisonCell value={row.memry} />
                  </td>
                  <td className="px-4 py-4">
                    <ComparisonCell value={row.notion} />
                  </td>
                  <td className="px-4 py-4">
                    <ComparisonCell value={row.obsidian} />
                  </td>
                  <td className="px-4 py-4">
                    <ComparisonCell value={row.logseq} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="rule-double text-ink/30" aria-hidden />
        </motion.div>

        <div className="space-y-3 md:hidden">
          {COMPARISON_DATA.rows.map((row) => (
            <article key={row.feature} className="border-b border-ink/10 pb-4">
              <h3 className="font-serif text-base leading-snug text-ink">{row.feature}</h3>
              <div className="mt-3 grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
                {comparisonColumns.map((column) => (
                  <div
                    key={column.key}
                    className={cn(
                      'flex min-h-11 items-center justify-between gap-3 rounded-sm border px-3 py-2',
                      column.featured
                        ? 'border-terracotta/30 bg-terracotta/5'
                        : 'border-border/50 bg-paper/60'
                    )}
                  >
                    <span
                      className={cn(
                        'min-w-0 text-xs font-medium',
                        column.featured ? 'italic text-terracotta' : 'text-muted'
                      )}
                    >
                      {column.label}
                    </span>
                    <ComparisonMobileValue value={row[column.key]} />
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>

        <div className="mt-8 space-y-3 text-center">
          <p className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono-accent text-sm text-muted">
            <span className="inline-flex items-center gap-2">
              <Check className="h-3 w-3 text-sage" /> Yes
            </span>
            <span className="inline-flex items-center gap-2">
              <Minus className="h-3 w-3 text-terracotta" /> Via plugin or partial
            </span>
            <span className="inline-flex items-center gap-2">
              <X className="h-3 w-3 text-muted" /> No
            </span>
          </p>
          {COMPARISON_DATA.footnote && (
            <p className="mx-auto max-w-lg text-xs leading-relaxed text-muted/60">
              {COMPARISON_DATA.footnote}
            </p>
          )}
        </div>
      </Container>
    </section>
  )
}
