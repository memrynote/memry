import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { HelmetProvider } from 'react-helmet-async'
import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'
import { Home } from '@/pages/Home'
import { FeaturesPage } from '@/pages/Features'
import { UseCasesPage } from '@/pages/UseCases'
import { SecurityPage } from '@/pages/Security'
import { NotFound } from '@/pages/NotFound'

function ScrollToHash() {
  const { pathname, hash } = useLocation()

  useEffect(() => {
    if (hash) {
      const id = hash.replace('#', '')
      const scrollTo = () => {
        const el = document.getElementById(id)
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' })
          return true
        }
        return false
      }
      if (!scrollTo()) {
        requestAnimationFrame(() => scrollTo())
      }
      return
    }
    window.scrollTo(0, 0)
  }, [pathname, hash])

  return null
}

function AppContent() {
  return (
    <div className="min-h-screen flex flex-col">
      <ScrollToHash />
      <Header />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/features" element={<FeaturesPage />} />
          <Route path="/use-cases" element={<UseCasesPage />} />
          <Route path="/security" element={<SecurityPage />} />
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
