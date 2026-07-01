import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { FAQ_ITEMS } from '@/lib/constants'

const REVEAL = {
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.8, ease: [0.16, 1, 0.3, 1] as const }
}

export function CleanNeutralFAQ() {
  return (
    <section className="py-24 border-t border-border/40">
      <Container size="md">
        <div className="grid gap-12 lg:grid-cols-[minmax(220px,1fr)_2fr]">
          <motion.div {...REVEAL} className="lg:sticky lg:top-28 lg:self-start">
            <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
              § 07 — Appendix
            </p>
            <h2 className="display-section mt-4 text-ink">
              Questions & <span className="italic text-terracotta">answers.</span>
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-muted">
              Everything you need to know before you download.
            </p>
          </motion.div>

          <motion.div {...REVEAL}>
            <Accordion type="single" collapsible className="w-full">
              {FAQ_ITEMS.map((item, i) => (
                <AccordionItem
                  key={item.question}
                  value={`faq-${i}`}
                  className="border-b border-border/60 last:border-0 rounded-none px-0 bg-transparent data-[state=open]:bg-transparent"
                >
                  <AccordionTrigger className="text-start text-ink text-lg hover:text-terracotta hover:no-underline py-5 font-serif">
                    <span className="flex items-baseline gap-4">
                      <span className="font-mono-accent text-[11px] tracking-[0.14em] text-muted/50">
                        Q.{String(i + 1).padStart(2, '0')}
                      </span>
                      {item.question}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted leading-relaxed pb-5 text-[17px] font-sans max-w-[90%]">
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
