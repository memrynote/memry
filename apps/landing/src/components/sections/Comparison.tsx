import { Check, X, Minus } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { SectionHeading } from '@/components/shared/SectionHeading'
import { COMPARISON_DATA } from '@/lib/constants'
import { cn } from '@/lib/utils'

function ComparisonCell({ value }: { value: boolean | 'partial' }) {
  if (value === true) {
    return (
      <div className="flex justify-center">
        <div className="w-6 h-6 rounded-full bg-sage/10 flex items-center justify-center">
          <Check className="w-4 h-4 text-sage" />
        </div>
      </div>
    )
  }

  if (value === 'partial') {
    return (
      <div className="flex justify-center">
        <div className="w-6 h-6 rounded-full bg-terracotta/10 flex items-center justify-center">
          <Minus className="w-4 h-4 text-terracotta" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-center">
      <div className="w-6 h-6 rounded-full bg-muted/10 flex items-center justify-center">
        <X className="w-4 h-4 text-muted/50" />
      </div>
    </div>
  )
}

export function Comparison() {
  return (
    <section className="py-24 zone-transition">
      <Container size="md">
        <SectionHeading
          title="How Memry compares"
          subtitle="We built Memry to be the PKM we wished existed."
        />

        <div className="overflow-x-auto rounded-xl border border-border/50 bg-white/50 shadow-sm">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border/60">
                {COMPARISON_DATA.headers.map((header, index) => (
                  <th
                    key={header || 'feature'}
                    className={cn(
                      'py-5 px-6 text-sm font-medium font-mono-accent uppercase tracking-wider',
                      index === 0 ? 'text-left text-ink' : 'text-center text-muted',
                      index === 1 &&
                        'text-terracotta font-bold text-base border-t-2 border-terracotta/40'
                    )}
                  >
                    {index === 1 ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-terracotta animate-pulse" />
                        {header}
                      </span>
                    ) : (
                      header
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON_DATA.rows.map((row) => (
                <tr
                  key={row.feature}
                  className="border-b border-border/40 hover:bg-paper-alt/50 transition-colors"
                >
                  <td className="py-4 px-6 text-sm font-medium text-ink">{row.feature}</td>
                  <td className="py-4 px-6 column-glow">
                    <ComparisonCell value={row.memry} />
                  </td>
                  <td className="py-4 px-6">
                    <ComparisonCell value={row.notion} />
                  </td>
                  <td className="py-4 px-6">
                    <ComparisonCell value={row.obsidian} />
                  </td>
                  <td className="py-4 px-6">
                    <ComparisonCell value={row.logseq} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="text-center mt-8 space-y-3">
          <p className="text-sm text-muted font-mono-accent">
            <span className="inline-flex items-center gap-2 mr-6">
              <Check className="w-3 h-3 text-sage" /> Yes
            </span>
            <span className="inline-flex items-center gap-2 mr-6">
              <Minus className="w-3 h-3 text-terracotta" /> Via plugin or partial
            </span>
            <span className="inline-flex items-center gap-2">
              <X className="w-3 h-3 text-muted" /> No
            </span>
          </p>
          {COMPARISON_DATA.footnote && (
            <p className="text-xs text-muted/60 max-w-lg mx-auto leading-relaxed">
              {COMPARISON_DATA.footnote}
            </p>
          )}
        </div>
      </Container>
    </section>
  )
}
