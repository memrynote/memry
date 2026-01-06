import { motion } from 'framer-motion'
import { Check, X, Minus } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { SectionHeading } from '@/components/shared/SectionHeading'
import { COMPARISON_DATA } from '@/lib/constants'
import { cn } from '@/lib/utils'

function ComparisonCell({ value }: { value: boolean | 'partial' }) {
  if (value === true) {
    return (
      <div className="flex justify-center">
        <div className="w-6 h-6 rounded-full bg-success/10 flex items-center justify-center">
          <Check className="w-4 h-4 text-success" />
        </div>
      </div>
    )
  }

  if (value === 'partial') {
    return (
      <div className="flex justify-center">
        <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
          <Minus className="w-4 h-4 text-primary" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-center">
      <div className="w-6 h-6 rounded-full bg-muted/10 flex items-center justify-center">
        <X className="w-4 h-4 text-muted" />
      </div>
    </div>
  )
}

export function Comparison() {
  return (
    <section className="py-24 bg-surface">
      <Container size="md">
        <SectionHeading
          title="How we compare"
          subtitle="We built Memry to be the PKM we wished existed."
        />

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.5 }}
          className="overflow-x-auto"
        >
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {COMPARISON_DATA.headers.map((header, index) => (
                  <th
                    key={header || 'feature'}
                    className={cn(
                      'py-4 px-4 text-sm font-medium',
                      index === 0 ? 'text-left' : 'text-center',
                      index === 1 && 'text-primary'
                    )}
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON_DATA.rows.map((row) => (
                <tr key={row.feature} className="border-b border-border/50">
                  <td className="py-4 px-4 text-sm text-foreground">{row.feature}</td>
                  <td className="py-4 px-4">
                    <ComparisonCell value={row.memry} />
                  </td>
                  <td className="py-4 px-4">
                    <ComparisonCell value={row.notion} />
                  </td>
                  <td className="py-4 px-4">
                    <ComparisonCell value={row.obsidian} />
                  </td>
                  <td className="py-4 px-4">
                    <ComparisonCell value={row.logseq} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </motion.div>

        <p className="text-center text-sm text-muted mt-6">
          <span className="inline-flex items-center gap-2 mr-4">
            <Check className="w-4 h-4 text-success" /> Yes
          </span>
          <span className="inline-flex items-center gap-2 mr-4">
            <Minus className="w-4 h-4 text-primary" /> Partial/Plugin
          </span>
          <span className="inline-flex items-center gap-2">
            <X className="w-4 h-4 text-muted" /> No
          </span>
        </p>
      </Container>
    </section>
  )
}
