import { useState, type FormEvent } from 'react'
import { motion } from 'motion/react'
import { ArrowRight, Loader2 } from 'lucide-react'
import { HomeSection } from '@/components/site/primitives'
import { trackLandingEvent } from '@/lib/analytics'
import { cn } from '@/lib/utils'

const EASE = [0.16, 1, 0.3, 1] as const

type Status = 'idle' | 'loading' | 'success' | 'error'

/**
 * Newsletter signup — the closing note under the download ask. One field, one arrow
 * button nested inside it, and on success the whole form is replaced by a single line:
 * the address is filed in Resend, there is nothing left to say or do.
 */
export function NewsletterSignup({ location }: { location: string }) {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  const handleSubmit = async (event: FormEvent) => {
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
    <HomeSection>
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.8, ease: EASE }}
        className="mx-auto w-full max-w-[420px] text-center"
      >
        <h2 className="display-section text-ink">Stay in the loop</h2>
        <p className="section-sub mx-auto mt-3 max-w-[320px]">
          Get the latest updates, product news, and tips straight to your inbox.
        </p>

        {status === 'success' ? (
          <p className="mt-8 text-[15px] font-medium text-ink">You&rsquo;re subscribed.</p>
        ) : (
          <form onSubmit={handleSubmit} className="relative mt-8">
            <label className="sr-only" htmlFor="newsletter-email">
              Email address
            </label>
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
                'text-center text-sm text-ink shadow-[0_6px_20px_rgb(43_61_78/0.06)]',
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
      </motion.div>
    </HomeSection>
  )
}
