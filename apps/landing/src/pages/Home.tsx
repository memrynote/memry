import { PageHead } from '@/components/shared/PageHead'
import { Hero2 } from '@/components/site/Hero2'
import { EverythingRow } from '@/components/site/EverythingRow'
import { UseCasesGallery } from '@/components/site/UseCasesGallery'
import { Features } from '@/components/sections/Features'
import { ConnectedShowcase } from '@/components/site/ConnectedShowcase'
import { StructureShowcase } from '@/components/site/StructureShowcase'
import { PrivacyShowcase } from '@/components/site/PrivacyShowcase'
import { CommunityLoop } from '@/components/site/CommunityLoop'
import { FinalCTA2 } from '@/components/site/FinalCTA2'
import { FounderNote } from '@/components/site/primitives'

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
