import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { FAQ_ITEMS } from '@/lib/constants'

export function CleanNeutralFAQ() {
  return (
    <section className="py-24 border-t border-border/40">
      <Container size="sm">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="text-center mb-12"
        >
          <h2 className="font-serif text-3xl md:text-4xl text-ink mb-3">Questions & answers</h2>
          <p className="text-muted text-lg">
            Everything you need to know before joining the waitlist.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          <Accordion type="single" collapsible className="w-full">
            {FAQ_ITEMS.map((item, i) => (
              <AccordionItem
                key={i}
                value={`faq-${i}`}
                className="border-b border-border/60 last:border-0 rounded-none px-0 bg-transparent data-[state=open]:bg-transparent"
              >
                <AccordionTrigger className="text-left text-ink text-lg hover:text-terracotta hover:no-underline py-5 font-serif">
                  {item.question}
                </AccordionTrigger>
                <AccordionContent className="text-muted leading-relaxed pb-5 text-[17px] font-sans max-w-[90%]">
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
