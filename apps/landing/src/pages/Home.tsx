import { PageHead } from '@/components/shared/PageHead'
import { Hero2 } from '@/components/sections/home2/Hero2'
import { EverythingRow } from '@/components/sections/home2/EverythingRow'
import { UseCasesGallery } from '@/components/sections/home2/UseCasesGallery'
import { NotesShowcase } from '@/components/sections/home2/NotesShowcase'
import { ConnectedShowcase } from '@/components/sections/home2/ConnectedShowcase'
import { TrustRow } from '@/components/sections/home2/TrustRow'
import { PlanShowcase } from '@/components/sections/home2/PlanShowcase'
import { StructureShowcase } from '@/components/sections/home2/StructureShowcase'
import { ThemesShowcase } from '@/components/sections/home2/ThemesShowcase'
import { CommunityLoop } from '@/components/sections/home2/CommunityLoop'
import { PricingTeaser } from '@/components/sections/home2/PricingTeaser'
import { FinalCTA2 } from '@/components/sections/home2/FinalCTA2'
import { FounderNote } from '@/components/sections/home2/primitives'

export function Home() {
  return (
    <>
      <PageHead page="home" jsonLd />
      <Hero2 />
      <EverythingRow />
      <UseCasesGallery />
      <NotesShowcase />
      <FounderNote>
        I built MemryNote because I was tired of my life being split across four apps that all
        wanted my data.
      </FounderNote>
      <ConnectedShowcase />
      <TrustRow />
      <FounderNote>
        Everything is a toggle. The app you end up with is the app you actually wanted.
      </FounderNote>
      <PlanShowcase />
      <StructureShowcase />
      <FounderNote>
        It's the one window that stays open all day — that was the whole goal.
      </FounderNote>
      <ThemesShowcase />
      <CommunityLoop />
      <PricingTeaser />
      <FinalCTA2 />
    </>
  )
}
