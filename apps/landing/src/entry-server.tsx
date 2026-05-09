import type { ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import { HelmetProvider, HelmetData, type HelmetServerState } from 'react-helmet-async'
import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'
import { Home } from '@/pages/Home'
import { FeaturesPage } from '@/pages/Features'
import { UseCasesPage } from '@/pages/UseCases'
import { SecurityPage } from '@/pages/Security'
import { PricingPage } from '@/pages/Pricing'
import { TermsPage } from '@/pages/Terms'
import { PrivacyPage } from '@/pages/Privacy'
import { RefundPage } from '@/pages/Refund'

const ROUTE_MAP: Record<string, () => ReactNode> = {
  '/': () => <Home />,
  '/features': () => <FeaturesPage />,
  '/use-cases': () => <UseCasesPage />,
  '/security': () => <SecurityPage />,
  '/pricing': () => <PricingPage />,
  '/terms': () => <TermsPage />,
  '/privacy': () => <PrivacyPage />,
  '/refund': () => <RefundPage />
}

export function render(url: string): { html: string; helmet: HelmetServerState | null } {
  const helmetData = new HelmetData({})
  const Page = ROUTE_MAP[url]

  const html = renderToString(
    <HelmetProvider context={helmetData.context}>
      <StaticRouter location={url}>
        <div className="min-h-screen flex flex-col">
          <Header />
          <main className="flex-1">{Page ? <Page /> : null}</main>
          <Footer />
        </div>
      </StaticRouter>
    </HelmetProvider>
  )

  return { html, helmet: helmetData.context.helmet }
}

export const ROUTES = Object.keys(ROUTE_MAP)
