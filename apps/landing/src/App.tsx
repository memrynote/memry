import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router'
import { useEffect } from 'react'
import { MotionConfig } from 'framer-motion'
import { HelmetProvider } from 'react-helmet-async'
import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'
import { SmoothScroll } from '@/components/layout/SmoothScroll'
import { PageGlow } from '@/components/shared/PageGlow'
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
import { CheckoutPage } from '@/pages/Checkout'
import { ChangelogPage } from '@/pages/Changelog'
import { RoadmapPage } from '@/pages/Roadmap'
import { TermsPage } from '@/pages/Terms'
import { PrivacyPage } from '@/pages/Privacy'
import { RefundPage } from '@/pages/Refund'
import { NotFound } from '@/pages/NotFound'
import { LoginPage } from '@/pages/Login'
import { AuthCallbackPage } from '@/pages/AuthCallback'
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
import { RequireAuth } from '@/components/account/RequireAuth'
import { AccountLayout } from '@/components/account/AccountLayout'
import { ProfileSection } from '@/pages/account/ProfileSection'
import { BillingSection } from '@/pages/account/BillingSection'
import { SyncSection } from '@/pages/account/SyncSection'
import { scrollToLandingTarget } from '@/lib/smooth-scroll'
import { trackLandingEvent, trackLandingPageView, type LandingEventName } from '@/lib/analytics'
import { AuthProvider } from '@/contexts/auth-context'
import { Analytics } from '@vercel/analytics/react'
import { SpeedInsights } from '@vercel/speed-insights/react'

const SCROLL_DEPTH_EVENTS: readonly { depth: number; event: LandingEventName }[] = [
  { depth: 25, event: 'landing_scroll_25' },
  { depth: 50, event: 'landing_scroll_50' },
  { depth: 75, event: 'landing_scroll_75' },
  { depth: 100, event: 'landing_scroll_100' }
]

function ScrollToHash() {
  const { pathname, hash } = useLocation()

  useEffect(() => {
    if (hash) {
      const id = hash.replace('#', '')
      const scrollTo = () => {
        const el = document.getElementById(id)
        if (el) {
          scrollToLandingTarget(el)
          return true
        }
        return false
      }
      if (!scrollTo()) {
        requestAnimationFrame(() => scrollTo())
      }
      return
    }
    scrollToLandingTarget(0, { immediate: true, offset: 0 })
  }, [pathname, hash])

  return null
}

function ScrollDepthAnalytics() {
  const { pathname } = useLocation()
  useEffect(() => {
    const firedDepths = new Set<number>()
    let frame = 0

    const measure = () => {
      frame = 0
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight
      const depth = maxScroll <= 0 ? 100 : Math.min((window.scrollY / maxScroll) * 100, 100)

      for (const { depth: threshold, event } of SCROLL_DEPTH_EVENTS) {
        if (depth >= threshold && !firedDepths.has(threshold)) {
          firedDepths.add(threshold)
          trackLandingEvent(event, `scroll:${threshold}`)
        }
      }
    }

    const scheduleMeasure = () => {
      if (frame) return
      frame = window.requestAnimationFrame(measure)
    }

    measure()
    window.addEventListener('scroll', scheduleMeasure, { passive: true })
    window.addEventListener('resize', scheduleMeasure)

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', scheduleMeasure)
      window.removeEventListener('resize', scheduleMeasure)
    }
  }, [pathname])

  return null
}

function PageViewAnalytics() {
  const { pathname, search } = useLocation()

  useEffect(() => {
    trackLandingPageView(pathname, search)
  }, [pathname, search])

  return null
}

// /login redirects legacy /auth links, preserving ?next= etc.
function LegacyAuthRedirect() {
  const { search } = useLocation()
  return <Navigate to={`/login${search}`} replace />
}

function AppContent() {
  // /login is a standalone surface: full-screen card, no site chrome.
  const standalone = useLocation().pathname === '/login'
  return (
    <div className="min-h-screen flex flex-col">
      <SmoothScroll />
      <ScrollToHash />
      <PageViewAnalytics />
      <ScrollDepthAnalytics />
      {!standalone && <Header />}
      <main className="relative isolate flex-1">
        {!standalone && <PageGlow />}
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/features" element={<FeaturesPage />} />
          <Route path="/features/notes" element={<NotesFeaturePage />} />
          <Route path="/features/inbox" element={<InboxFeaturePage />} />
          <Route path="/features/journal" element={<JournalFeaturePage />} />
          <Route path="/features/tasks" element={<TasksFeaturePage />} />
          <Route path="/features/calendar" element={<CalendarFeaturePage />} />
          <Route path="/features/ai-agent" element={<AIAgentFeaturePage />} />
          <Route path="/features/web-clipper" element={<WebClipperFeaturePage />} />
          <Route path="/download/desktop" element={<DownloadDesktopPage />} />
          <Route path="/cli" element={<CliPage />} />
          <Route path="/use-cases" element={<UseCasesPage />} />
          <Route path="/security" element={<SecurityPage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route path="/alternatives" element={<Navigate to="/compare" replace />} />
          <Route path="/obsidian-alternative" element={<ObsidianAlternativePage />} />
          <Route path="/notion-alternative" element={<NotionAlternativePage />} />
          <Route path="/noteplan-alternative" element={<NotePlanAlternativePage />} />
          <Route path="/capacities-alternative" element={<CapacitiesAlternativePage />} />
          <Route path="/evernote-alternative" element={<EvernoteAlternativePage />} />
          <Route path="/logseq-alternative" element={<LogseqAlternativePage />} />
          <Route path="/anytype-alternative" element={<AnytypeAlternativePage />} />
          <Route path="/apple-notes-alternative" element={<AppleNotesAlternativePage />} />
          <Route path="/bear-alternative" element={<BearAlternativePage />} />
          <Route path="/roam-research-alternative" element={<RoamAlternativePage />} />
          <Route path="/onenote-alternative" element={<OneNoteAlternativePage />} />
          <Route path="/upnote-alternative" element={<UpNoteAlternativePage />} />
          <Route path="/joplin-alternative" element={<JoplinAlternativePage />} />
          <Route path="/google-keep-alternative" element={<GoogleKeepAlternativePage />} />
          <Route path="/tana-alternative" element={<TanaAlternativePage />} />
          <Route path="/heptabase-alternative" element={<HeptabaseAlternativePage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/changelog" element={<ChangelogPage />} />
          <Route path="/roadmap" element={<RoadmapPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/refund" element={<RefundPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/auth" element={<LegacyAuthRedirect />} />
          <Route path="/auth/oauth/callback" element={<AuthCallbackPage />} />
          <Route
            path="/account"
            element={
              <RequireAuth>
                <AccountLayout />
              </RequireAuth>
            }
          >
            <Route index element={<ProfileSection />} />
            <Route path="profile" element={<ProfileSection />} />
            <Route path="billing" element={<BillingSection />} />
            <Route path="sync" element={<SyncSection />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      {!standalone && <Footer />}
    </div>
  )
}

export default function App() {
  return (
    <HelmetProvider>
      <BrowserRouter>
        <AuthProvider>
          {/* reducedMotion="user": transform/layout animations degrade to crossfades
              for prefers-reduced-motion users, across every motion.* on the site. */}
          <MotionConfig reducedMotion="user">
            <AppContent />
          </MotionConfig>
          <Analytics />
          <SpeedInsights />
        </AuthProvider>
      </BrowserRouter>
    </HelmetProvider>
  )
}
