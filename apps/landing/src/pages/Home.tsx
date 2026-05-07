import { PageHead } from '@/components/shared/PageHead'
import { Hero } from '@/components/sections/Hero'
import { FlowShowcase } from '@/components/sections/FlowShowcase'
import { Features } from '@/components/sections/Features'
import { Comparison } from '@/components/sections/Comparison'
import { SecurityShowcase } from '@/components/sections/SecurityShowcase'
import { FounderStory } from '@/components/sections/FounderStory'
import { Roadmap } from '@/components/sections/Roadmap'
import { CleanNeutralFAQ } from '@/components/sections/FAQ'
import { FinalCTA } from '@/components/sections/FinalCTA'

export function Home() {
  return (
    <>
      <PageHead page="home" jsonLd />
      <Hero />
      <FlowShowcase />
      <Features />
      <Comparison />
      <SecurityShowcase />
      <FounderStory />
      <Roadmap />
      <CleanNeutralFAQ />
      <FinalCTA />
    </>
  )
}
