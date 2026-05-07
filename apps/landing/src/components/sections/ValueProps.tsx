import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { VALUE_PROPS } from '@/lib/constants'

export function ValueProps() {
  return (
    <section className="py-24 border-y border-border/40 bg-paper-alt/30">
      <Container>
        <div className="grid md:grid-cols-3 gap-12 md:gap-8">
          {VALUE_PROPS.map((prop, index) => (
            <motion.div
              key={prop.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.8, delay: index * 0.15, ease: [0.16, 1, 0.3, 1] }}
              className="text-center group"
            >
              <div className="mb-6 inline-flex items-center justify-center relative">
                <div className="absolute inset-0 bg-terracotta/5 rounded-full scale-0 group-hover:scale-150 transition-transform duration-500 ease-out" />
                <prop.icon
                  className="w-8 h-8 text-terracotta relative z-10 transition-transform duration-300 group-hover:-translate-y-1"
                  strokeWidth={1.5}
                />
              </div>
              <h3 className="font-serif text-2xl text-ink mb-3 group-hover:text-terracotta transition-colors duration-300">
                {prop.title}
              </h3>
              <p className="text-muted font-sans leading-relaxed max-w-xs mx-auto">
                {prop.description}
              </p>
            </motion.div>
          ))}
        </div>
      </Container>
    </section>
  )
}
