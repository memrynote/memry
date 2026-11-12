import { useEffect, useRef, useState, type SyntheticEvent } from 'react'
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
  'The TestFlight app from the App Store.'
] as const

const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const TURNSTILE_SITE_KEY: unknown = import.meta.env.VITE_TURNSTILE_SITE_KEY

/** The slice of the Turnstile browser API this page uses. */
interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string
      appearance: 'interaction-only'
      callback: (token: string) => void
      'expired-callback': () => void
      'error-callback': () => void
    }
  ): string
  remove(widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let turnstileScript: Promise<TurnstileApi> | undefined

function loadTurnstile(): Promise<TurnstileApi> {
  turnstileScript ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = TURNSTILE_SCRIPT_URL
    script.async = true
    script.addEventListener('load', () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load'))
    )
    script.addEventListener('error', () => reject(new Error('Turnstile script failed to load')))
    document.head.append(script)
  })
  return turnstileScript
}

/**
 * Cloudflare Turnstile bot check. It stays invisible unless Cloudflare wants an interaction.
 * A token is single-use, so the form remounts this (new `key`) after each failed submit.
 */
function TurnstileWidget({ onToken }: { onToken: (token: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sitekey = typeof TURNSTILE_SITE_KEY === 'string' ? TURNSTILE_SITE_KEY : ''
    let widgetId: string | undefined
    let cancelled = false
    const turnstileReady = sitekey
      ? loadTurnstile()
      : Promise.reject(new Error('VITE_TURNSTILE_SITE_KEY is not configured'))
    turnstileReady
      .then((turnstile) => {
        if (cancelled || !containerRef.current) return
        widgetId = turnstile.render(containerRef.current, {
          sitekey,
          appearance: 'interaction-only',
          callback: onToken,
          'expired-callback': () => onToken(''),
          'error-callback': () => onToken('')
        })
      })
      .catch((error: unknown) => console.error('[ios-beta]', error))
    return () => {
      cancelled = true
      if (widgetId) window.turnstile?.remove(widgetId)
    }
  }, [onToken])

  return <div ref={containerRef} className="mt-3 flex justify-center" />
}

/**
 * Invite form for the iPhone TestFlight beta. Unlisted (noindex, not in PAGE_META or the
 * sitemap): visitors arrive from /download, the phone hero, and the beta email. Through
 * /api/subscribe the address joins the external TestFlight group, so Apple sends the invite,
 * and the Resend "iOS beta" segment.
 */
export function IosBetaPage() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [turnstileToken, setTurnstileToken] = useState('')
  const [attempt, setAttempt] = useState(0)

  const fail = (message: string) => {
    trackLandingEvent('landing_ios_beta_error', 'ios-beta')
    setErrorMessage(message)
    setStatus('error')
    setTurnstileToken('')
    setAttempt((count) => count + 1)
  }

  const handleSubmit = async (event: SyntheticEvent) => {
    event.preventDefault()
    if (!email || status === 'loading') return
    if (!turnstileToken) {
      setErrorMessage('Please wait for the verification to finish, then try again.')
      setStatus('error')
      return
    }

    trackLandingEvent('landing_ios_beta_submit', 'ios-beta')
    setStatus('loading')
    setErrorMessage('')

    try {
      const response = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, list: 'ios-beta', turnstileToken })
      })
      const data = await response.json()

      if (response.ok && data.success) {
        trackLandingEvent('landing_ios_beta_success', 'ios-beta')
        setStatus('success')
        setEmail('')
        return
      }

      fail(typeof data.error === 'string' ? data.error : 'Something went wrong')
    } catch {
      fail('Network error. Please try again.')
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
        sub="The iPhone beta is open on TestFlight. Leave the email you want the invite sent to, and Apple emails the TestFlight invite to that address."
        actions={
          status === 'success' ? (
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- live status region; output element would change inline layout
            <p role="status" className="text-[15px] font-medium text-ink">
              You&rsquo;re in. Apple is sending your TestFlight invite to that address. Check your
              spam folder if it does not show up.
            </p>
          ) : (
            <form
              onSubmit={(event) => void handleSubmit(event)}
              className="relative w-full max-w-[420px]"
            >
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

              <TurnstileWidget key={attempt} onToken={setTurnstileToken} />

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
            <p className="mt-3 text-muted">
              That is all. The app works on its own on your phone, offline, for free. If you want
              the vault from your desktop on your phone too, a paid plan syncs the two, end-to-end
              encrypted.
            </p>
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
            from any of those emails. Apple receives the address to send the TestFlight invite, and
            Cloudflare Turnstile checks the form for bots. See the{' '}
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
