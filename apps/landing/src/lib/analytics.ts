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

type PostHogClient = typeof import('posthog-js/dist/module.full.no-external').default
type PostHogConfig = NonNullable<Parameters<PostHogClient['init']>[1]>

const POSTHOG_KEY = import.meta.env?.VITE_POSTHOG_KEY
const POSTHOG_HOST = import.meta.env?.VITE_POSTHOG_HOST
const PRIVATE_REPLAY_SELECTOR = '[data-private], [data-sensitive], [data-ph-no-capture]'
const URL_PROPERTY_KEYS = [
  '$current_url',
  '$pathname',
  '$referrer',
  '$session_entry_url',
  '$session_entry_pathname'
]

let posthogClient: Promise<PostHogClient | null> | null = null

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

export function sanitizeCapturedNetworkRequest<
  T extends {
    name?: unknown
    requestBody?: unknown
    responseBody?: unknown
    requestHeaders?: unknown
    responseHeaders?: unknown
  }
>(request: T): T {
  if (typeof request.name === 'string') request.name = stripQueryAndHash(request.name)

  request.requestBody = undefined
  request.responseBody = undefined
  request.requestHeaders = undefined
  request.responseHeaders = undefined

  return request
}

export function sanitizePostHogEvent<T extends { properties?: Record<string, unknown> }>(
  event: T
): T {
  if (!event.properties) return event

  for (const key of URL_PROPERTY_KEYS) {
    const value = event.properties[key]
    if (typeof value === 'string') event.properties[key] = stripQueryAndHash(value)
  }

  return event
}

export function createLandingPostHogConfig(): PostHogConfig {
  return {
    api_host: POSTHOG_HOST,
    advanced_disable_feature_flags: true,
    autocapture: false,
    before_send: (event) => {
      if (!event) return event
      return sanitizePostHogEvent(event)
    },
    capture_performance: false,
    capture_pageview: false,
    capture_pageleave: true,
    disable_external_dependency_loading: true,
    disable_session_recording: false,
    disable_surveys: true,
    person_profiles: 'identified_only',
    request_batching: false,
    session_recording: {
      blockClass: 'ph-no-capture',
      blockSelector: PRIVATE_REPLAY_SELECTOR,
      maskAllInputs: true,
      maskCapturedNetworkRequestFn: (request) => sanitizeCapturedNetworkRequest(request),
      maskTextSelector: '*'
    }
  }
}

function getPostHogClient(): Promise<PostHogClient | null> {
  if (typeof window === 'undefined' || !POSTHOG_KEY || !POSTHOG_HOST) return Promise.resolve(null)

  posthogClient ??= import('posthog-js/dist/module.full.no-external')
    .then(({ default: posthog }) => {
      posthog.init(POSTHOG_KEY, createLandingPostHogConfig())

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
