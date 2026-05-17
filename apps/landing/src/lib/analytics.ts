import { track } from '@vercel/analytics'

export type LandingEventName =
  | 'landing_scroll_25'
  | 'landing_scroll_50'
  | 'landing_scroll_75'
  | 'landing_scroll_100'
  | 'landing_nav_click'
  | 'landing_waitlist_submit'
  | 'landing_waitlist_success'
  | 'landing_waitlist_error'
  | 'landing_pricing_cadence_change'
  | 'landing_pricing_cta_click'
  | 'landing_download_click'
  | 'landing_external_click'
  | 'landing_demo_start'
  | 'landing_demo_pause'
  | 'landing_demo_resume'
  | 'landing_demo_tab_click'
  | 'landing_demo_seek'
  | 'landing_demo_rewind'
  | 'landing_demo_progress_25'
  | 'landing_demo_progress_50'
  | 'landing_demo_progress_75'
  | 'landing_demo_complete'
  | 'landing_demo_mute'
  | 'landing_demo_unmute'
  | 'landing_demo_expand'

export type LandingEventData = {
  page: string
  target: string
}

function stripQueryAndHash(value: string): string {
  return value.split(/[?#]/)[0] || 'unknown'
}

export function createLandingEventData(target: string, pathname: string): LandingEventData {
  return {
    page: stripQueryAndHash(pathname),
    target: stripQueryAndHash(target)
  }
}

export function trackLandingEvent(name: LandingEventName, target: string): void {
  if (typeof window === 'undefined') return

  track(name, createLandingEventData(target, window.location.pathname))
}
