import { PageHead } from '@/components/shared/PageHead'
import { Hero2 } from '@/components/site/Hero2'
import { EverythingRow } from '@/components/site/EverythingRow'
import { SplitVsOne } from '@/components/site/SplitVsOne'
import { UseCasesGallery } from '@/components/site/UseCasesGallery'
import { Features } from '@/components/sections/Features'
import { ConnectedShowcase } from '@/components/site/ConnectedShowcase'
import { PrivacyShowcase } from '@/components/site/PrivacyShowcase'
import { CommunityLoop } from '@/components/site/CommunityLoop'
import { FinalCta } from '@/components/site/FinalCta'
import { NewsletterSignup } from '@/components/site/NewsletterSignup'
import { SectionRule } from '@/components/site/primitives'

export function Home() {
  return (
    <>
      <PageHead page="home" jsonLd />
      <Hero2 />

      {/* Everything below the hero sits inside the page grid: two dashed rails run down
          the sides and carry on through the footer, with a dashed seam between sections. */}
      <div className="page-rails home-sections">
        <EverythingRow />
        <SectionRule />
        <SplitVsOne />
        <SectionRule />
        <Features />
        <SectionRule />
        <ConnectedShowcase />
        <SectionRule />
        <UseCasesGallery />
        <SectionRule />
        <PrivacyShowcase />
        <SectionRule />
        <CommunityLoop />
        <SectionRule />
        <FinalCta
          title={
            <>
              One window for your <em className="text-terracotta">whole day.</em>
            </>
          }
          sub="Free to start. Private by default. Yours forever."
          location="home-final"
          secondary={{ label: 'See pricing', to: '/pricing', event: 'pricing:home-final' }}
        />
        <SectionRule />
        <NewsletterSignup location="home-final" />
      </div>
    </>
  )
}
