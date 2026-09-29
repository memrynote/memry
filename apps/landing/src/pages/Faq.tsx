import { PageHead } from '@/components/shared/PageHead'
import { Faq } from '@/components/site/Faq'
import { FinalCta } from '@/components/site/FinalCta'
import { PageHero } from '@/components/site/PageHero'
import { FAQ_ITEMS, REDDIT_URL } from '@/lib/constants'
import { getFaqPageJsonLd } from '@/lib/seo'

export function FaqPage() {
  return (
    <>
      <PageHead page="faq" pageJsonLd={getFaqPageJsonLd()} />
      <main>
        <PageHero
          title="Questions, answered."
          sub="What is free, what works offline, where your files live, and what we can and cannot see."
        />
        <Faq
          eyebrow="FAQ"
          title={
            <>
              Before you <span className="italic text-terracotta">move in.</span>
            </>
          }
          sub={
            <>
              Missing something? Ask on{' '}
              <a
                href={REDDIT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink underline underline-offset-4 hover:text-terracotta"
              >
                r/MemryNote
              </a>{' '}
              or email{' '}
              <a
                href="mailto:kaan@memrynote.com"
                className="text-ink underline underline-offset-4 hover:text-terracotta"
              >
                kaan@memrynote.com
              </a>
              .
            </>
          }
          items={FAQ_ITEMS}
        />
        <FinalCta
          title={
            <>
              One window for your <em className="text-terracotta">whole day.</em>
            </>
          }
          sub="Free to start. Private by default. Yours forever."
          location="faq-final"
          secondary={{ label: 'See pricing', to: '/pricing', event: 'pricing:faq-final' }}
        />
      </main>
    </>
  )
}
