import { PageHead } from '@/components/shared/PageHead'
import { Hero2 } from '@/components/sections/home2/Hero2'
import { EverythingRow } from '@/components/sections/home2/EverythingRow'
import { UseCasesGallery } from '@/components/sections/home2/UseCasesGallery'
import { Features } from '@/components/sections/Features'
import { ConnectedShowcase } from '@/components/sections/home2/ConnectedShowcase'
import { StructureShowcase } from '@/components/sections/home2/StructureShowcase'
import { PrivacyShowcase } from '@/components/sections/home2/PrivacyShowcase'
import { CommunityLoop } from '@/components/sections/home2/CommunityLoop'
import { FinalCTA2 } from '@/components/sections/home2/FinalCTA2'
import { FounderNote } from '@/components/sections/home2/primitives'

export function Home() {
  return (
    <>
      <PageHead page="home" jsonLd />
      <Hero2 />
      <EverythingRow />
      <Features />
      <FounderNote>
        I built MemryNote because I was tired of my life being split across four apps that all
        wanted my data.
      </FounderNote>
      <ConnectedShowcase />
      <UseCasesGallery />
      <FounderNote>
        Everything is a toggle. The app you end up with is the app you actually wanted.
      </FounderNote>
      <StructureShowcase />
      <FounderNote>
        It's the one window that stays open all day — that was the whole goal.
      </FounderNote>
      <PrivacyShowcase />
      <CommunityLoop />
      <FinalCTA2 />
    </>
  )
}
