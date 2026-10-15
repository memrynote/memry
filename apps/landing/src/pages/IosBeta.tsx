import { useState, type FormEvent } from 'react'
import { Helmet } from 'react-helmet-async'
import { Link } from 'react-router'
import { ArrowRight, Loader2 } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHero } from '@/components/site/PageHero'
import { IosScreenshotCarousel } from '@/components/site/IosScreenshotCarousel'
import { trackLandingEvent } from '@/lib/analytics'
import { cn } from '@/lib/utils'

type Status = 'idle' | 'loading' | 'success' | 'error'

const REQUIREMENTS = [
  'An iPhone on iOS 26 or later.',
  'The TestFlight app from the App Store.',
  'A paid memrynote plan. The phone gets your vault through end-to-end encrypted sync.'
] as const

/**
 * Invite list for the iPhone TestFlight beta. Unlisted (noindex, not in PAGE_META or the
 * sitemap): visitors arrive from the navbar, the phone hero, and the beta email. The address
 * goes to the Resend "iOS beta" segment through /api/subscribe.
 */
export function IosBetaPage() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!email || status === 'loading') return

    trackLandingEvent('landing_ios_beta_submit', 'ios-beta')
    setStatus('loading')
    setErrorMessage('')

    try {
      const response = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, list: 'ios-beta' })
      })
      const data = await response.json()

      if (response.ok && data.success) {
        trackLandingEvent('landing_ios_beta_success', 'ios-beta')
        setStatus('success')
        setEmail('')
        return
      }

      trackLandingEvent('landing_ios_beta_error', 'ios-beta')
      setErrorMessage(typeof data.error === 'string' ? data.error : 'Something went wrong')
      setStatus('error')
    } catch {
      trackLandingEvent('landing_ios_beta_error', 'ios-beta')
      setErrorMessage('Network error. Please try again.')
      setStatus('error')
    }
  }

  return (
    <>
      <Helmet>
        <title>iPhone beta — memrynote</title>
        <meta
          name="description"
          content="Get an invite to the memrynote iPhone beta on TestFlight."
        />
        <meta name="robots" content="noindex" />
      </Helmet>

      <PageHero
        title={
          <>
            memrynote for <span className="italic text-terracotta">iPhone.</span>
          </>
        }
        sub="The TestFlight beta opens in the next few days, as soon as Apple approves the build. Leave the email you want the invite sent to, and you will get it when the beta opens."
        actions={
          status === 'success' ? (
            <p role="status" className="text-[15px] font-medium text-ink">
              You&rsquo;re on the list. Watch your inbox for the invite.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="relative w-full max-w-[420px]">
              <label className="sr-only" htmlFor="ios-beta-email">
                Email for your TestFlight invite
              </label>
              <input
                id="ios-beta-email"
                type="email"
                required
                autoComplete="email"
                placeholder="Email for your TestFlight invite"
                data-ph-mask
                value={email}
                disabled={status === 'loading'}
                onChange={(e) => {
                  setEmail(e.target.value)
                  if (status === 'error') setStatus('idle')
                }}
                className={cn(
                  'h-14 w-full rounded-[18px] border border-ink/[0.13] bg-card ps-5 pe-[62px]',
                  'text-center text-sm text-ink shadow-[0_6px_20px_rgb(43_61_78/0.06)]',
                  'placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-terracotta/40',
                  status === 'error' && 'border-red-500/70'
                )}
              />
              <button
                type="submit"
                disabled={status === 'loading'}
                aria-label="Request an invite"
                className="absolute end-2.5 top-[28px] grid size-[38px] -translate-y-1/2 place-items-center rounded-full bg-terracotta text-white transition-colors duration-200 hover:bg-terracotta-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40 disabled:opacity-70"
              >
                {status === 'loading' ? (
                  <Loader2 className="size-[18px] animate-spin" aria-hidden />
                ) : (
                  <ArrowRight className="size-[18px]" strokeWidth={2.2} aria-hidden />
                )}
              </button>

              {status === 'error' && (
                <p role="alert" className="mt-3 text-center text-sm text-red-600">
                  {errorMessage}
                </p>
              )}
            </form>
          )
        }
      />

      <IosScreenshotCarousel />

      <Container size="sm" className="pb-24 pt-4">
        <div className="mx-auto max-w-[520px] space-y-10 text-[15px] leading-relaxed text-ink">
          <section>
            <h2 className="font-editorial text-xl font-medium tracking-[-0.02em]">What you need</h2>
            <ul className="mt-3 list-disc space-y-1.5 ps-5 text-muted">
              {REQUIREMENTS.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="font-editorial text-xl font-medium tracking-[-0.02em]">
              What is in the beta
            </h2>
            <p className="mt-3 text-muted">
              A native app on the same vault as your desktop. Write and edit notes, plan and check
              off tasks, keep your journal, check your calendar, and search all of it. Share links,
              photos and files to your inbox from any app, or record a voice memo that becomes text
              on the phone. Home boards, the graph, canvases and Agent Chat are not on the phone
              yet.
            </p>
            <p className="mt-3 text-muted">
              The App Store release is planned for the end of November. Android comes after that.
            </p>
          </section>

          <p className="text-[13px] text-muted">
            We use this address only for the beta invite and beta updates, and you can unsubscribe
            from any of those emails. If the invite comes through TestFlight, Apple receives the
            address to send it. See the{' '}
            <Link to="/privacy" className="underline underline-offset-4 hover:text-ink">
              privacy policy
            </Link>
            .
          </p>
        </div>
      </Container>
    </>
  )
}
