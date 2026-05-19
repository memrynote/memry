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
  | 'landing_calculator_bundle_select'

export type LandingEventData = {
  page: string
  target: string
}

export type LandingPageViewData = {
  page: string
}

const POSTHOG_KEY = import.meta.env?.VITE_POSTHOG_KEY
const POSTHOG_HOST = import.meta.env?.VITE_POSTHOG_HOST

let posthogClient: Promise<typeof import('posthog-js').default | null> | null = null

function stripQueryAndHash(value: string): string {
  return value.split(/[?#]/)[0] || 'unknown'
}

export function createLandingEventData(target: string, pathname: string): LandingEventData {
  return {
    page: stripQueryAndHash(pathname),
    target: stripQueryAndHash(target)
  }
}

export function createLandingPageViewData(pathname: string): LandingPageViewData {
  return {
    page: stripQueryAndHash(pathname)
  }
}

function getPostHogClient(): Promise<typeof import('posthog-js').default | null> {
  if (typeof window === 'undefined' || !POSTHOG_KEY || !POSTHOG_HOST) return Promise.resolve(null)

  posthogClient ??= import('posthog-js')
    .then(({ default: posthog }) => {
      posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        advanced_disable_feature_flags: true,
        autocapture: false,
        capture_performance: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_external_dependency_loading: true,
        disable_session_recording: true,
        disable_surveys: true,
        person_profiles: 'identified_only',
        request_batching: false
      })

      return posthog
    })
    .catch(() => null)

  return posthogClient
}

export function trackLandingPageView(pathname: string): void {
  if (typeof window === 'undefined') return

  void getPostHogClient().then((posthog) => {
    posthog?.capture('$pageview', createLandingPageViewData(pathname))
  })
}

export function trackLandingEvent(name: LandingEventName, target: string): void {
  if (typeof window === 'undefined') return

  void getPostHogClient().then((posthog) => {
    posthog?.capture(name, createLandingEventData(target, window.location.pathname))
  })
}
