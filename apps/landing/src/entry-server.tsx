import type { ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import { MotionConfig } from 'motion/react'
import { HelmetProvider, HelmetData, type HelmetServerState } from 'react-helmet-async'
import { AuthProvider } from '@/contexts/auth-context'
import { SiteShell } from '@/components/layout/SiteShell'
import { Home } from '@/pages/Home'
import { FeaturesPage } from '@/pages/Features'
import { NotesFeaturePage } from '@/pages/Notes'
import { InboxFeaturePage } from '@/pages/Inbox'
import { JournalFeaturePage } from '@/pages/Journal'
import { TasksFeaturePage } from '@/pages/Tasks'
import { CalendarFeaturePage } from '@/pages/Calendar'
import { AIAgentFeaturePage } from '@/pages/AIAgent'
import { WebClipperFeaturePage } from '@/pages/WebClipper'
import { DownloadDesktopPage } from '@/pages/DownloadDesktop'
import { CliPage } from '@/pages/Cli'
import { UseCasesPage } from '@/pages/UseCases'
import { SecurityPage } from '@/pages/Security'
import { PricingPage } from '@/pages/Pricing'
import { ChangelogPage } from '@/pages/Changelog'
import { RoadmapPage } from '@/pages/Roadmap'
import { TermsPage } from '@/pages/Terms'
import { PrivacyPage } from '@/pages/Privacy'
import { RefundPage } from '@/pages/Refund'
import { CheckoutPage } from '@/pages/Checkout'
import { LoginPage } from '@/pages/Login'
import { AuthCallbackPage } from '@/pages/AuthCallback'
import { RequireAuth } from '@/components/account/RequireAuth'
import { AccountLayout } from '@/components/account/AccountLayout'
import {
  ObsidianAlternativePage,
  NotionAlternativePage,
  NotePlanAlternativePage,
  CapacitiesAlternativePage,
  EvernoteAlternativePage,
  LogseqAlternativePage,
  AnytypeAlternativePage,
  AppleNotesAlternativePage,
  BearAlternativePage,
  RoamAlternativePage,
  OneNoteAlternativePage,
  UpNoteAlternativePage,
  JoplinAlternativePage,
  GoogleKeepAlternativePage,
  TanaAlternativePage,
  HeptabaseAlternativePage
} from '@/pages/AlternativePage'
import { ComparePage } from '@/pages/ComparePage'
import { BlogIndexPage } from '@/pages/BlogIndex'
import {
  JournalLongevityPostPage,
  E2EEncryptionPostPage,
  LocalFirstOfflinePostPage,
  TerminalPkmPostPage,
  MarkdownMigrationPostPage
} from '@/pages/BlogPost'
import { NotFound } from '@/pages/NotFound'

// Account routes are gated by RequireAuth, which renders null until the client is
// ready, so prerendering emits an empty shell (no session/localStorage access during
// SSR). main.tsx re-renders via createRoot (not hydrate), so this shell is replaced
// on mount; it exists only so direct loads/refreshes get a file instead of a 404.
const accountShell = () => (
  <RequireAuth>
    <AccountLayout />
  </RequireAuth>
)

const ROUTE_MAP: Record<string, () => ReactNode> = {
  '/': () => <Home />,
  '/features': () => <FeaturesPage />,
  '/features/notes': () => <NotesFeaturePage />,
  '/features/inbox': () => <InboxFeaturePage />,
  '/features/journal': () => <JournalFeaturePage />,
  '/features/tasks': () => <TasksFeaturePage />,
  '/features/calendar': () => <CalendarFeaturePage />,
  '/features/ai-agent': () => <AIAgentFeaturePage />,
  '/features/web-clipper': () => <WebClipperFeaturePage />,
  '/download/desktop': () => <DownloadDesktopPage />,
  '/cli': () => <CliPage />,
  '/use-cases': () => <UseCasesPage />,
  '/security': () => <SecurityPage />,
  '/compare': () => <ComparePage />,
  '/obsidian-alternative': () => <ObsidianAlternativePage />,
  '/notion-alternative': () => <NotionAlternativePage />,
  '/noteplan-alternative': () => <NotePlanAlternativePage />,
  '/capacities-alternative': () => <CapacitiesAlternativePage />,
  '/evernote-alternative': () => <EvernoteAlternativePage />,
  '/logseq-alternative': () => <LogseqAlternativePage />,
  '/anytype-alternative': () => <AnytypeAlternativePage />,
  '/apple-notes-alternative': () => <AppleNotesAlternativePage />,
  '/bear-alternative': () => <BearAlternativePage />,
  '/roam-research-alternative': () => <RoamAlternativePage />,
  '/onenote-alternative': () => <OneNoteAlternativePage />,
  '/upnote-alternative': () => <UpNoteAlternativePage />,
  '/joplin-alternative': () => <JoplinAlternativePage />,
  '/google-keep-alternative': () => <GoogleKeepAlternativePage />,
  '/tana-alternative': () => <TanaAlternativePage />,
  '/heptabase-alternative': () => <HeptabaseAlternativePage />,
  '/pricing': () => <PricingPage />,
  '/changelog': () => <ChangelogPage />,
  '/roadmap': () => <RoadmapPage />,
  '/terms': () => <TermsPage />,
  '/privacy': () => <PrivacyPage />,
  '/refund': () => <RefundPage />,
  '/blog': () => <BlogIndexPage />,
  '/blog/how-to-keep-a-plain-text-daily-journal-that-outlives-any-app': () => (
    <JournalLongevityPostPage />
  ),
  '/blog/what-end-to-end-encrypted-notes-actually-means': () => <E2EEncryptionPostPage />,
  '/blog/local-first-vs-cloud-first-note-taking-apps': () => <LocalFirstOfflinePostPage />,
  '/blog/running-a-pkm-from-the-terminal': () => <TerminalPkmPostPage />,
  '/blog/migrating-from-evernote-notion-to-markdown': () => <MarkdownMigrationPostPage />,
  // Client-only app routes: no SEO value, but they must be prerendered as static
  // shells so direct loads (e.g. the desktop "Upgrade" deep link to /checkout#token,
  // the Google OAuth redirect to /auth/oauth/callback) resolve instead of 404ing.
  '/checkout': () => <CheckoutPage />,
  '/login': () => <LoginPage />,
  // Legacy /auth links redirect to /login on the client; shell keeps direct loads from 404ing.
  '/auth': () => <LoginPage />,
  '/auth/oauth/callback': () => <AuthCallbackPage />,
  '/account': accountShell,
  '/account/profile': accountShell,
  '/account/billing': accountShell,
  '/account/sync': accountShell,
  // Prerendered to dist/404.html; Vercel serves it as the not-found fallback (HTTP 404).
  '/404': () => <NotFound />
}

// Standalone surfaces render without site chrome — mirrors AppContent's escape in App.tsx.
const STANDALONE_ROUTES = new Set(['/login', '/auth'])

export function render(url: string): { html: string; helmet: HelmetServerState | null } {
  const helmetData = new HelmetData({})
  const Page = ROUTE_MAP[url]
  const standalone = STANDALONE_ROUTES.has(url)

  const html = renderToString(
    <HelmetProvider context={helmetData.context}>
      <StaticRouter location={url}>
        <AuthProvider>
          {/* Same reducedMotion mode as App: motion writes a component's initial style
              into the markup, so a different config here would render different HTML
              than the client hydrates with. */}
          <MotionConfig reducedMotion="user">
            <SiteShell standalone={standalone}>{Page ? <Page /> : null}</SiteShell>
          </MotionConfig>
        </AuthProvider>
      </StaticRouter>
    </HelmetProvider>
  )

  return { html, helmet: helmetData.context.helmet }
}

export const ROUTES = Object.keys(ROUTE_MAP)
