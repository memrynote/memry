import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
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
import { TermsPage } from '@/pages/Terms'
import { PrivacyPage } from '@/pages/Privacy'
import { RefundPage } from '@/pages/Refund'
import { NotFound } from '@/pages/NotFound'
import { scrollToLandingTarget } from '@/lib/smooth-scroll'

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

function AppContent() {
  return (
    <div className="min-h-screen flex flex-col">
      <SmoothScroll />
      <ScrollToHash />
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
