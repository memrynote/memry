import { motion } from 'framer-motion'
import { Check } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { SectionHeading } from '@/components/shared/SectionHeading'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { PRICING_TIERS } from '@/lib/constants'
import { cn } from '@/lib/utils'

export function Pricing() {
  return (
    <section id="pricing" className="py-24 bg-paper-alt/50 border-t border-border/50">
      <Container size="md">
        <SectionHeading
          title="Simple, honest pricing"
          subtitle="No hidden fees, no feature gates. Just tools to help you think better."
        />

        <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          {PRICING_TIERS.map((tier, index) => (
            <motion.div
              key={tier.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.8, delay: index * 0.15, ease: [0.16, 1, 0.3, 1] }}
            >
              <Card
                className={cn(
                  'h-full relative transition-all duration-300',
                  tier.highlighted
                    ? 'border-terracotta/50 shadow-elevated scale-[1.02] md:scale-105 z-10'
                    : 'border-border/60 hover:border-terracotta/30'
                )}
              >
                {tier.highlighted && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="bg-terracotta text-white text-xs font-mono-accent tracking-wider font-medium px-4 py-1 rounded-full uppercase">
                      Support us
                    </span>
                  </div>
                )}

                <CardHeader className="text-center pb-6 pt-8">
                  <CardTitle className="font-serif text-3xl font-normal text-ink">
                    {tier.name}
                  </CardTitle>
                  <div className="mt-4 flex items-baseline justify-center gap-1">
                    <span className="text-4xl font-mono-accent font-medium text-ink">
                      {tier.price}
                    </span>
                    <span className="text-muted font-sans text-sm">{tier.period}</span>
                  </div>
                  {'yearlyPrice' in tier && tier.yearlyPrice && (
                    <p className="text-sm text-terracotta font-medium mt-1 font-mono-accent">
                      {tier.yearlyPrice}
                    </p>
                  )}
                  <CardDescription className="mt-4 text-base leading-relaxed">
                    {tier.description}
                  </CardDescription>
                </CardHeader>

                <CardContent className="pt-2 pb-8 px-8">
                  <ul className="space-y-4 mb-8">
                    {tier.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-3 text-sm">
                        <div className="mt-0.5 rounded-full border border-terracotta/30 p-0.5 shrink-0">
                          <Check className="w-3 h-3 text-terracotta" />
                        </div>
                        <span className="text-ink/80">{feature}</span>
                      </li>
                    ))}
                  </ul>

                  <Button
                    variant={tier.highlighted ? 'default' : 'secondary'}
                    className="w-full font-medium"
                    asChild
                  >
                    <a href="#waitlist">{tier.cta}</a>
                  </Button>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </Container>
    </section>
  )
}
