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
    <section id="pricing" className="py-24">
      <Container size="md">
        <SectionHeading
          title="Simple, honest pricing"
          subtitle="No hidden fees, no feature gates. Just tools to help you think better."
        />

        <div className="grid md:grid-cols-2 gap-8 max-w-3xl mx-auto">
          {PRICING_TIERS.map((tier, index) => (
            <motion.div
              key={tier.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
            >
              <Card
                className={cn('h-full relative', tier.highlighted && 'border-primary shadow-lg')}
              >
                {tier.highlighted && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="bg-primary text-primary-foreground text-xs font-medium px-3 py-1 rounded-full">
                      Support us
                    </span>
                  </div>
                )}

                <CardHeader className="text-center pb-2">
                  <CardTitle className="text-xl">{tier.name}</CardTitle>
                  <div className="mt-4">
                    <span className="text-4xl font-bold text-foreground">{tier.price}</span>
                    <span className="text-muted ml-1">{tier.period}</span>
                  </div>
                  {'yearlyPrice' in tier && tier.yearlyPrice && (
                    <p className="text-sm text-muted mt-1">or {tier.yearlyPrice}</p>
                  )}
                  <CardDescription className="mt-3">{tier.description}</CardDescription>
                </CardHeader>

                <CardContent className="pt-4">
                  <ul className="space-y-3 mb-6">
                    {tier.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-3 text-sm">
                        <Check className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                        <span className="text-muted">{feature}</span>
                      </li>
                    ))}
                  </ul>

                  <Button
                    variant={tier.highlighted ? 'default' : 'secondary'}
                    className="w-full"
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
