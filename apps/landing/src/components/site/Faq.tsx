import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { Container } from '@/components/layout/Container'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { cn } from '@/lib/utils'

const EASE = [0.16, 1, 0.3, 1] as const

const RISE = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' } as const,
  transition: { duration: 0.8, ease: EASE }
}

export interface FaqItem {
  question: string
  answer: ReactNode
}

export interface FaqProps {
  eyebrow?: string
  title: ReactNode
  sub?: ReactNode
  /** readonly so `as const` fixtures in lib/constants pass straight through. */
  items: readonly FaqItem[]
  className?: string
}

/**
 * The site's one FAQ: a sticky heading beside a numbered accordion.
 *
 * Two layouts were in circulation — Pricing's two-column sticky version and Download's
 * plain centered one. Rather than grow a prop to switch between them (a config that
 * reshapes layout is the tell that the abstraction is wrong), this picks the two-column
 * version as canonical: it matches the SectionTitle rhythm and keeps the question list
 * readable when there are many items.
 */
export function Faq({ eyebrow, title, sub, items, className }: FaqProps) {
  return (
    <section className={cn('border-t border-border/40 py-24', className)}>
      <Container size="md">
        <div className="grid gap-12 lg:grid-cols-[minmax(220px,1fr)_2fr]">
          <motion.div {...RISE} className="lg:sticky lg:top-28 lg:self-start">
            {eyebrow && (
              <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
                {eyebrow}
              </p>
            )}
            <h2 className="display-section mt-4 text-ink">{title}</h2>
            {sub && <p className="mt-4 text-lg leading-relaxed text-muted">{sub}</p>}
          </motion.div>

          <motion.div {...RISE}>
            <Accordion type="single" collapsible className="w-full">
              {items.map((item, i) => (
                <AccordionItem
                  key={item.question}
                  value={`faq-${i}`}
                  className="rounded-none border-b border-border/60 bg-transparent px-0 last:border-0 data-[state=open]:bg-transparent"
                >
                  <AccordionTrigger className="py-5 text-start font-serif text-lg text-ink hover:text-terracotta hover:no-underline">
                    <span className="flex items-baseline gap-4">
                      <span className="font-mono-accent text-[11px] tracking-[0.14em] text-muted/50">
                        Q.{String(i + 1).padStart(2, '0')}
                      </span>
                      {item.question}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="max-w-[90%] pb-5 font-sans text-[17px] leading-relaxed text-muted">
                    {item.answer}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </motion.div>
        </div>
      </Container>
    </section>
  )
}
