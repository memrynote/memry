import { Hero } from '@/components/sections/Hero'
import { ValueProps } from '@/components/sections/ValueProps'
import { SavingsCalculator } from '@/components/sections/SavingsCalculator'
import { Features } from '@/components/sections/Features'
import { Comparison } from '@/components/sections/Comparison'
import { Roadmap } from '@/components/sections/Roadmap'
import { Pricing } from '@/components/sections/Pricing'
import { FAQ } from '@/components/sections/FAQ'
import { FinalCTA } from '@/components/sections/FinalCTA'

export function Home() {
  return (
    <>
      <Hero />
      <ValueProps />
      <SavingsCalculator />
      <Features />
      <Comparison />
      <Roadmap />
      <Pricing />
      <FAQ />
      <FinalCTA />
    </>
  )
}
