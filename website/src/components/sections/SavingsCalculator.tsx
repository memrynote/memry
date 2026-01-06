import { useState, useEffect } from 'react'
import { motion, useSpring, useTransform } from 'framer-motion'
import { Check } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { Button } from '@/components/ui/button'
import { COMPETITOR_TOOLS } from '@/lib/constants'
import { cn } from '@/lib/utils'

function AnimatedNumber({ value }: { value: number }) {
  const spring = useSpring(value, { stiffness: 100, damping: 30 })
  const display = useTransform(spring, (current) => Math.round(current))
  const [displayValue, setDisplayValue] = useState(value)

  useEffect(() => {
    spring.set(value)
  }, [spring, value])

  useEffect(() => {
    return display.on('change', (latest) => {
      setDisplayValue(latest)
    })
  }, [display])

  return <>{displayValue}</>
}

export function SavingsCalculator() {
  const [selectedTools, setSelectedTools] = useState<Set<string>>(() => {
    const defaults = new Set<string>()
    COMPETITOR_TOOLS.forEach((tool) => {
      if (tool.defaultSelected) {
        defaults.add(tool.id)
      }
    })
    return defaults
  })

  const toggleTool = (id: string) => {
    setSelectedTools((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const monthlySavings = COMPETITOR_TOOLS.filter((tool) => selectedTools.has(tool.id)).reduce(
    (sum, tool) => sum + tool.price,
    0
  )

  const annualSavings = monthlySavings * 12

  return (
    <section className="py-24 bg-card/50">
      <Container>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-12"
        >
          <h2 className="font-display text-3xl md:text-4xl font-semibold text-foreground mb-4">
            One app. Zero subscriptions.
          </h2>
          <p className="text-lg text-muted max-w-2xl mx-auto">
            Select the tools you currently pay for. See how much you save with Memry.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="max-w-4xl mx-auto"
        >
          <div className="bg-background rounded-2xl border border-border shadow-sm overflow-hidden">
            <div className="p-6 md:p-8 border-b border-border">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {COMPETITOR_TOOLS.map((tool) => {
                  const isSelected = selectedTools.has(tool.id)
                  return (
                    <button
                      key={tool.id}
                      type="button"
                      onClick={() => toggleTool(tool.id)}
                      className={cn(
                        'flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left',
                        isSelected
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-primary/50 hover:bg-card'
                      )}
                    >
                      <div
                        className={cn(
                          'w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors',
                          isSelected ? 'bg-primary border-primary' : 'border-muted-foreground/30'
                        )}
                      >
                        {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-foreground block truncate">
                          {tool.name}
                        </span>
                      </div>
                      <span className="text-sm text-muted shrink-0">${tool.price}/mo</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="p-6 md:p-8 bg-card/30">
              <div className="grid grid-cols-3 gap-4 md:gap-8">
                <div className="text-center">
                  <p className="text-xs md:text-sm text-muted mb-1">With Memry</p>
                  <p className="text-2xl md:text-3xl font-display font-bold text-primary">$0</p>
                  <p className="text-xs text-muted">/month</p>
                </div>
                <div className="text-center">
                  <p className="text-xs md:text-sm text-muted mb-1">Monthly savings</p>
                  <p className="text-2xl md:text-3xl font-display font-bold text-foreground">
                    $<AnimatedNumber value={monthlySavings} />
                  </p>
                  <p className="text-xs text-muted">/month</p>
                </div>
                <div className="text-center">
                  <p className="text-xs md:text-sm text-muted mb-1">Annual savings</p>
                  <p className="text-2xl md:text-3xl font-display font-bold text-emerald-600">
                    $<AnimatedNumber value={annualSavings} />
                  </p>
                  <p className="text-xs text-muted">/year</p>
                </div>
              </div>

              <div className="mt-8 text-center">
                <Button size="lg" asChild>
                  <a href="#waitlist">
                    Start saving with Memry
                    <span className="ml-2">→</span>
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </motion.div>
      </Container>
    </section>
  )
}
