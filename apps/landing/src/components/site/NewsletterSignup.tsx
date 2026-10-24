import { useState, type SyntheticEvent } from 'react'
import { ArrowRight, Loader2 } from 'lucide-react'
import { trackLandingEvent } from '@/lib/analytics'
import { cn } from '@/lib/utils'

type Status = 'idle' | 'loading' | 'success' | 'error'

/**
 * Newsletter signup, the quiet second ask inside the closing CTA panel. One field, one
 * arrow button nested inside it, and on success the whole form is replaced by a single
 * line: the address is filed in Resend, there is nothing left to say or do.
 */
export function NewsletterSignup({ location }: { location: string }) {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  const handleSubmit = async (event: SyntheticEvent) => {
    event.preventDefault()
    if (!email || status === 'loading') return

    trackLandingEvent('landing_newsletter_submit', `newsletter:${location}`)
    setStatus('loading')
    setErrorMessage('')

    try {
      const response = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      })
      const data = await response.json()

      if (response.ok && data.success) {
        trackLandingEvent('landing_newsletter_success', `newsletter:${location}`)
        setStatus('success')
        setEmail('')
        return
      }

      trackLandingEvent('landing_newsletter_error', `newsletter:${location}`)
      setErrorMessage(typeof data.error === 'string' ? data.error : 'Something went wrong')
      setStatus('error')
    } catch {
      trackLandingEvent('landing_newsletter_error', `newsletter:${location}`)
      setErrorMessage('Network error. Please try again.')
      setStatus('error')
    }
  }

  return (
    <div id="newsletter" className="mx-auto mt-14 w-full max-w-[380px] scroll-mt-24">
      <label htmlFor="newsletter-email" className="block text-sm text-muted">
        Not ready yet? Get product news by email.
      </label>

      {status === 'success' ? (
        <p className="mt-3 text-[15px] font-medium text-ink">You&rsquo;re subscribed.</p>
      ) : (
        <form onSubmit={(event) => void handleSubmit(event)} className="relative mt-3">
          <input
            id="newsletter-email"
            type="email"
            required
            autoComplete="email"
            placeholder="Enter your email"
            value={email}
            disabled={status === 'loading'}
            onChange={(e) => {
              setEmail(e.target.value)
              if (status === 'error') setStatus('idle')
            }}
            className={cn(
              'h-14 w-full rounded-[18px] border border-ink/[0.13] bg-card ps-5 pe-[62px]',
              'text-start text-sm text-ink shadow-[0_6px_20px_rgb(43_61_78/0.06)]',
              'placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-terracotta/40',
              status === 'error' && 'border-red-500/70'
            )}
          />
          <button
            type="submit"
            disabled={status === 'loading'}
            aria-label="Subscribe"
            className="absolute end-2.5 top-1/2 grid size-[38px] -translate-y-1/2 place-items-center rounded-full bg-terracotta text-white transition-colors duration-200 hover:bg-terracotta-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40 disabled:opacity-70"
          >
            {status === 'loading' ? (
              <Loader2 className="size-[18px] animate-spin" aria-hidden />
            ) : (
              <ArrowRight className="size-[18px]" strokeWidth={2.2} aria-hidden />
            )}
          </button>

          {status === 'error' && (
            <p role="alert" className="mt-3 text-sm text-red-600">
              {errorMessage}
            </p>
          )}
        </form>
      )}
    </div>
  )
}
