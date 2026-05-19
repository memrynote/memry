import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { useEffect, useRef } from 'react'
import { HelmetProvider } from 'react-helmet-async'
import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'
import { SmoothScroll } from '@/components/layout/SmoothScroll'
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
import { ChangelogPage } from '@/pages/Changelog'
import { RoadmapPage } from '@/pages/Roadmap'
import { TermsPage } from '@/pages/Terms'
import { PrivacyPage } from '@/pages/Privacy'
import { RefundPage } from '@/pages/Refund'
import { NotFound } from '@/pages/NotFound'
import { scrollToLandingTarget } from '@/lib/smooth-scroll'
import { trackLandingEvent, trackLandingPageView, type LandingEventName } from '@/lib/analytics'

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
  const firedDepthsRef = useRef<Set<number>>(new Set())

  useEffect(() => {
    firedDepthsRef.current = new Set()
    let frame = 0

    const measure = () => {
      frame = 0
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight
      const depth = maxScroll <= 0 ? 100 : Math.min((window.scrollY / maxScroll) * 100, 100)

      for (const { depth: threshold, event } of SCROLL_DEPTH_EVENTS) {
        if (depth >= threshold && !firedDepthsRef.current.has(threshold)) {
          firedDepthsRef.current.add(threshold)
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
  const { pathname } = useLocation()

  useEffect(() => {
    trackLandingPageView(pathname)
  }, [pathname])

  return null
}

function AppContent() {
  return (
    <div className="min-h-screen flex flex-col">
      <SmoothScroll />
      <ScrollToHash />
      <PageViewAnalytics />
      <ScrollDepthAnalytics />
      <Header />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/features" element={<FeaturesPage />} />
          <Route path="/features/notes" element={<NotesFeaturePage />} />
          <Route path="/features/inbox" element={<InboxFeaturePage />} />
          <Route path="/features/journal" element={<JournalFeaturePage />} />
          <Route path="/features/tasks" element={<TasksFeaturePage />} />
          <Route path="/features/calendar" element={<CalendarFeaturePage />} />
          <Route path="/features/ai-agent" element={<AIAgentFeaturePage />} />
          <Route path="/download/desktop" element={<DownloadDesktopPage />} />
          <Route path="/use-cases" element={<UseCasesPage />} />
          <Route path="/security" element={<SecurityPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/changelog" element={<ChangelogPage />} />
          <Route path="/roadmap" element={<RoadmapPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/refund" element={<RefundPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}

export default function App() {
  return (
    <HelmetProvider>
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </HelmetProvider>
  )
}
