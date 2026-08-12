import { motion } from 'motion/react'
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
    <section className="border-t border-border/40 py-24 md:py-28">
      <Container size="md">
        <div className="grid gap-12 lg:grid-cols-[minmax(220px,1fr)_2fr]">
          <motion.div {...REVEAL} className="lg:sticky lg:top-28 lg:self-start">
            <p className="font-mono-accent text-[11px] uppercase tracking-[0.2em] text-terracotta">
              Questions
            </p>
            <h2 className="display-section mt-4 text-ink">
              Before you <em className="text-terracotta">download.</em>
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-muted">
              The short version of everything people ask. More in the docs.
            </p>
          </motion.div>

          <motion.div {...REVEAL}>
            <Accordion type="single" collapsible className="w-full">
              {FAQ_ITEMS.map((item, i) => (
                <AccordionItem
                  key={item.question}
                  value={`faq-${i}`}
                  className="rounded-none border-b border-border/60 bg-transparent px-0 last:border-0 data-[state=open]:bg-transparent"
                >
                  <AccordionTrigger className="py-5 text-start font-serif text-lg text-ink hover:text-terracotta hover:no-underline">
                    {item.question}
                  </AccordionTrigger>
                  <AccordionContent className="max-w-[90%] pb-5 text-base leading-relaxed text-muted">
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
