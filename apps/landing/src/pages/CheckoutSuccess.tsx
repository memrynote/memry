import { useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Helmet } from 'react-helmet-async'
import { motion } from 'framer-motion'
import { CheckCircle2, Download, ExternalLink, ShieldCheck } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { Button } from '@/components/ui/button'
import { BASE_URL, SITE_NAME } from '@/lib/seo'
import { buildMemryBillingCompleteUrl } from '@/lib/paddle-checkout'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'

export function CheckoutSuccessPage() {
  const location = useLocation()
  const transactionId = useMemo(() => {
    const value = new URLSearchParams(location.search).get('transactionId')?.trim()
    return value || null
  }, [location.search])
  const openMemryUrl = transactionId ? buildMemryBillingCompleteUrl(transactionId) : 'memry://'

  return (
    <>
      <Helmet>
        <title>{`Payment completed - ${SITE_NAME}`}</title>
        <meta
          name="description"
          content="Your memrynote Sync payment completed. Sign in to the app to use sync across all your devices."
        />
        <meta name="robots" content="noindex,nofollow" />
        <link rel="canonical" href={`${BASE_URL}/checkout/success`} />
      </Helmet>
      <main>
        <section className="relative overflow-hidden pt-32 pb-20 md:pt-40 md:pb-28">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] bg-[radial-gradient(ellipse_at_top,rgba(97,132,101,0.16),transparent_60%)]"
          />
          <Container size="md">
            <motion.div
              initial={BLUR_REVEAL_INITIAL}
              animate={BLUR_REVEAL_ANIMATE}
              transition={BLUR_REVEAL_TRANSITION}
              className="mx-auto flex max-w-2xl flex-col items-center text-center"
            >
              <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-sage/12 text-sage">
                <CheckCircle2 className="h-7 w-7" strokeWidth={2.2} aria-hidden />
              </span>
              <p className="mt-6 font-mono-accent text-[11px] uppercase tracking-[0.24em] text-sage">
                Paddle checkout
              </p>
              <h1 className="mt-4 font-serif text-4xl font-normal leading-[1.05] text-ink text-balance md:text-6xl">
                Payment completed
              </h1>
              <p className="mt-6 max-w-xl text-base leading-relaxed text-muted md:text-lg">
                Sign in to the app to use sync across all your devices. Memry will unlock hosted
                sync for the account that started this checkout.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Button asChild size="lg">
                  <a href={openMemryUrl}>
                    <ExternalLink className="h-4 w-4" aria-hidden />
                    Open Memry
                  </a>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="border-ink/15 bg-paper-alt/40 text-ink hover:bg-paper-alt"
                >
                  <Link to="/download/desktop">
                    <Download className="h-4 w-4" aria-hidden />
                    Download app
                  </Link>
                </Button>
              </div>
              <div className="mt-10 grid w-full gap-3 text-start sm:grid-cols-2">
                <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-card">
                  <ShieldCheck className="h-5 w-5 text-sage" strokeWidth={2} aria-hidden />
                  <h2 className="mt-4 font-serif text-xl text-ink">End-to-end encrypted</h2>
                  <p className="mt-2 text-sm leading-relaxed text-muted">
                    Sync data is encrypted on your device before it leaves the app.
                  </p>
                </div>
                <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-card">
                  <CheckCircle2 className="h-5 w-5 text-sage" strokeWidth={2} aria-hidden />
                  <h2 className="mt-4 font-serif text-xl text-ink">All devices</h2>
                  <p className="mt-2 text-sm leading-relaxed text-muted">
                    After signing in, the same vault can stay current across desktop devices.
                  </p>
                </div>
              </div>
            </motion.div>
          </Container>
        </section>
      </main>
    </>
  )
}
