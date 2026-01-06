import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { WaitlistForm } from '@/components/shared/WaitlistForm'

export function FinalCTA() {
  return (
    <section className="py-24">
      <Container size="sm">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.5 }}
          className="text-center"
        >
          <h2 className="font-display text-3xl md:text-4xl font-semibold text-foreground mb-4">
            Ready to think beautifully?
          </h2>
          <p className="text-lg text-muted font-serif mb-8">
            Join thousands of others waiting for early access.
          </p>

          <WaitlistForm variant="centered" />

          <p className="text-sm text-muted mt-4">We'll never spam. Unsubscribe anytime.</p>
        </motion.div>
      </Container>
    </section>
  )
}
