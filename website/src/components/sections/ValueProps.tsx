import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { VALUE_PROPS } from '@/lib/constants'

export function ValueProps() {
  return (
    <section className="py-20 bg-surface">
      <Container>
        <div className="grid md:grid-cols-3 gap-8">
          {VALUE_PROPS.map((prop, index) => (
            <motion.div
              key={prop.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
              className="text-center p-6"
            >
              <div className="w-14 h-14 mx-auto mb-4 rounded-xl bg-primary/10 flex items-center justify-center">
                <prop.icon className="w-7 h-7 text-primary" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">{prop.title}</h3>
              <p className="text-muted text-sm leading-relaxed">{prop.description}</p>
            </motion.div>
          ))}
        </div>
      </Container>
    </section>
  )
}
