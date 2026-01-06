import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { SectionHeading } from '@/components/shared/SectionHeading'
import { MockupFrame } from '@/components/shared/MockupFrame'
import { FEATURES } from '@/lib/constants'
import { cn } from '@/lib/utils'

export function Features() {
  return (
    <section id="features" className="py-24">
      <Container>
        <SectionHeading
          title="Four pillars of thought"
          subtitle="Everything you need to capture, organize, and act on your ideas. Nothing you don't."
        />

        <div className="space-y-24">
          {FEATURES.map((feature, index) => (
            <motion.div
              key={feature.id}
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              className={cn(
                'grid md:grid-cols-2 gap-12 items-center',
                index % 2 === 1 && 'md:grid-flow-dense'
              )}
            >
              <div className={cn(index % 2 === 1 && 'md:col-start-2')}>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <feature.icon className="w-5 h-5 text-primary" />
                  </div>
                  <h3 className="font-display text-2xl font-semibold text-foreground">
                    {feature.title}
                  </h3>
                </div>

                <p className="text-xl text-primary font-serif italic mb-4">{feature.tagline}</p>

                <p className="text-muted mb-6 leading-relaxed">{feature.description}</p>

                <ul className="grid grid-cols-2 gap-2">
                  {feature.highlights.map((highlight) => (
                    <li key={highlight} className="flex items-center gap-2 text-sm text-muted">
                      <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                      {highlight}
                    </li>
                  ))}
                </ul>
              </div>

              <div className={cn(index % 2 === 1 && 'md:col-start-1 md:row-start-1')}>
                <MockupFrame
                  imageSrc={feature.screenshot}
                  imageAlt={`${feature.title} feature screenshot`}
                />
              </div>
            </motion.div>
          ))}
        </div>
      </Container>
    </section>
  )
}
