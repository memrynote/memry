import type { ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import { HelmetProvider, HelmetData, type HelmetServerState } from 'react-helmet-async'
import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'
import { Home } from '@/pages/Home'
import { FeaturesPage } from '@/pages/Features'
import { NotesFeaturePage } from '@/pages/Notes'
import { InboxFeaturePage } from '@/pages/Inbox'
import { JournalFeaturePage } from '@/pages/Journal'
import { TasksFeaturePage } from '@/pages/Tasks'
import { CalendarFeaturePage } from '@/pages/Calendar'
import { AIAgentFeaturePage } from '@/pages/AIAgent'
import { DownloadDesktopPage } from '@/pages/DownloadDesktop'
import { UseCasesPage } from '@/pages/UseCases'
import { SecurityPage } from '@/pages/Security'
import { PricingPage } from '@/pages/Pricing'
import { TermsPage } from '@/pages/Terms'
import { PrivacyPage } from '@/pages/Privacy'
import { RefundPage } from '@/pages/Refund'

const ROUTE_MAP: Record<string, () => ReactNode> = {
  '/': () => <Home />,
  '/features': () => <FeaturesPage />,
  '/features/notes': () => <NotesFeaturePage />,
  '/features/inbox': () => <InboxFeaturePage />,
  '/features/journal': () => <JournalFeaturePage />,
  '/features/tasks': () => <TasksFeaturePage />,
  '/features/calendar': () => <CalendarFeaturePage />,
  '/features/ai-agent': () => <AIAgentFeaturePage />,
  '/download/desktop': () => <DownloadDesktopPage />,
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
