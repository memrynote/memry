import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { SectionHeading } from '@/components/shared/SectionHeading'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { FAQ_ITEMS } from '@/lib/constants'

export function FAQ() {
  return (
    <section className="py-24 bg-paper">
      <Container size="sm">
        <SectionHeading
          title="Frequently asked questions"
          subtitle="Everything you need to know about Memry."
        />

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          <Accordion type="single" collapsible className="w-full space-y-4">
            {FAQ_ITEMS.map((item, index) => (
              <AccordionItem
                key={index}
                value={`item-${index}`}
                className="border border-border/60 rounded-lg px-6 bg-white/50 data-[state=open]:bg-white transition-colors"
              >
                <AccordionTrigger className="text-left text-ink font-serif text-xl hover:text-terracotta hover:no-underline py-6">
                  {item.question}
                </AccordionTrigger>
                <AccordionContent className="text-muted leading-relaxed pb-6 text-base font-sans">
                  {item.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </motion.div>
      </Container>
    </section>
  )
}
