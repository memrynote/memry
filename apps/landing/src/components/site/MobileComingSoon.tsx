import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { trackLandingEvent } from '@/lib/analytics'

/**
 * Hero ask for phone visitors. The desktop installers are useless on a phone, so the
 * hero states the mobile launch, points beta testers at the existing "Stay in the
 * loop" signup further down the page, and keeps a quiet link to the desktop downloads.
 */
export function MobileComingSoon({ location }: { location: string }) {
  return (
    <div className="mx-auto flex w-full max-w-[360px] flex-col items-center gap-4">
      <p className="text-[15px] font-semibold text-ink">Mobile app coming end of November</p>

      <a
        href="#newsletter"
        onClick={() => trackLandingEvent('landing_nav_click', `mobile-beta:${location}`)}
        className="group/pill inline-flex min-h-[58px] items-center justify-center gap-[22px] rounded-[18px] border-2 border-white/85 bg-terracotta py-[5px] ps-[21px] pe-1.5 shadow-[0_0_0_5px_rgb(255_255_255/0.58)] transition-colors duration-200 hover:bg-terracotta-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/50"
      >
        <span className="text-[14px] font-semibold leading-[18px] text-white">
          Join the TestFlight beta
        </span>
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white text-terracotta">
          <ArrowRight className="h-[18px] w-[18px]" strokeWidth={2.2} aria-hidden />
        </span>
      </a>

      <Link
        to="/download/desktop"
        onClick={() => trackLandingEvent('landing_nav_click', `download:all-platforms:${location}`)}
        className="text-[13px] text-muted underline underline-offset-4 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
      >
        Looking for the desktop app? Tap here
      </Link>
    </div>
  )
}
