import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { SectionHeading } from '@/components/shared/SectionHeading'
import { MockupFrame } from '@/components/shared/MockupFrame'
import { WaitlistForm } from '@/components/shared/WaitlistForm'
import { FEATURES } from '@/lib/constants'

export function FeaturesPage() {
  return (
    <main className="pt-24">
      <section className="py-16">
        <Container>
          <SectionHeading
            title="Everything you need"
            subtitle="Four integrated tools designed to work together seamlessly. No plugins required."
          />
        </Container>
      </section>

      {FEATURES.map((feature, index) => (
        <section key={feature.id} className={index % 2 === 0 ? 'py-16' : 'py-16 bg-surface'}>
          <Container>
            <motion.div
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              className="grid lg:grid-cols-2 gap-12 items-center"
            >
              <div className={index % 2 === 1 ? 'lg:order-2' : ''}>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                    <feature.icon className="w-6 h-6 text-primary" />
                  </div>
                  <h2 className="font-display text-3xl font-semibold text-foreground">
                    {feature.title}
                  </h2>
                </div>

                <p className="text-2xl text-primary font-serif italic mb-6">{feature.tagline}</p>

                <p className="text-lg text-muted mb-8 leading-relaxed">{feature.description}</p>

                <div className="grid sm:grid-cols-2 gap-4">
                  {feature.highlights.map((highlight) => (
                    <div key={highlight} className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-primary" />
                      <span className="text-foreground">{highlight}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className={index % 2 === 1 ? 'lg:order-1' : ''}>
                <MockupFrame
                  imageSrc={feature.screenshot}
                  imageAlt={`${feature.title} feature in Memry`}
                />
              </div>
            </motion.div>
          </Container>
        </section>
      ))}

      <section className="py-24 bg-surface">
        <Container size="sm">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center"
          >
            <h2 className="font-display text-3xl font-semibold text-foreground mb-4">
              Ready to get started?
            </h2>
            <p className="text-lg text-muted font-serif mb-8">
              Join the waitlist for early access.
            </p>
            <WaitlistForm variant="centered" />
          </motion.div>
        </Container>
      </section>
    </main>
  )
}
