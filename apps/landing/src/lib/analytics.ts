// posthog-js has no package.json "exports"/"browser" field, so the bare
// specifier resolves to the lean dist/module.js bundle, which has no rrweb
// compiled in and lazy-loads /static/recorder.js as a <script> for replay.
// disable_external_dependency_loading blocks that fetch, so session replay
// silently never starts. This subpath bundles rrweb in directly.
import posthog from 'posthog-js/dist/module.full.no-external'

export type LandingEventName =
  | 'landing_scroll_25'
  | 'landing_scroll_50'
  | 'landing_scroll_75'
  | 'landing_scroll_100'
  | 'landing_nav_click'
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
  | 'landing_hero_demo_open'
  | 'landing_calculator_bundle_select'
  | 'landing_account_open'
  | 'landing_account_signin'
  | 'landing_account_signout'

export type LandingCampaignKey =
  'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_content' | 'utm_term'

export type LandingCampaignData = Partial<Record<LandingCampaignKey, string>>

export type LandingEventData = {
  page: string
  target: string
} & LandingCampaignData

export type LandingPageViewData = {
  page: string
} & LandingCampaignData

const CAMPAIGN_PARAM_KEYS: readonly LandingCampaignKey[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term'
]
const CAMPAIGN_VALUE_LIMIT = 120

function stripQueryAndHash(value: string): string {
  return value.split(/[?#]/)[0] || 'unknown'
}

function normalizeCampaignValue(value: string): string | undefined {
  const normalized = value.trim()
  if (!normalized || /[\r\n]/.test(normalized)) return undefined
  return normalized.slice(0, CAMPAIGN_VALUE_LIMIT)
}

export function readLandingCampaignParams(search: string): LandingCampaignData {
  const campaign: LandingCampaignData = {}
  const params = new URLSearchParams(search)

  for (const key of CAMPAIGN_PARAM_KEYS) {
    const value = params.get(key)
    if (!value) continue

    const normalized = normalizeCampaignValue(value)
    if (normalized) campaign[key] = normalized
  }

  return campaign
}

export function createLandingEventData(
  target: string,
  pathname: string,
  search = ''
): LandingEventData {
  return {
    page: stripQueryAndHash(pathname),
    target: stripQueryAndHash(target),
    ...readLandingCampaignParams(search)
  }
}

export function createLandingPageViewData(pathname: string, search = ''): LandingPageViewData {
  return {
    page: stripQueryAndHash(pathname),
    ...readLandingCampaignParams(search)
  }
}

// Product analytics + session replay via posthog-js, direct to PostHog's
// reverse-proxy subdomain. Session replay cannot be server-proxied, so this
// replaces the old sendBeacon/fetch pipe into sync-server. `init` no-ops when
// there is no window (SSR/prerender) or no PostHog key configured, and only
// runs once.
let initialised = false

function init(): boolean {
  if (initialised) return true
  if (typeof window === 'undefined') return false
  const key = import.meta.env.VITE_POSTHOG_KEY
  if (!key) return false

  posthog.init(key, {
    api_host: import.meta.env.VITE_POSTHOG_HOST ?? 'https://e.memrynote.com',
    person_profiles: 'identified_only',
    disable_external_dependency_loading: true,
    capture_pageview: false,
    session_recording: {
      maskAllInputs: true,
      // maskAllInputs only covers <input>/<textarea> values; account, login
      // and checkout screens also render PII (email addresses, OTP-delivery
      // confirmations) as plain text nodes, which rrweb captures verbatim by
      // default. Elements tagged data-ph-mask have their text replaced with
      // asterisks in the replay snapshot. See ProfileSection.tsx and
      // Login.tsx for the tagged subtrees.
      maskTextSelector: '[data-ph-mask]'
    }
  })
  // vite build always runs in 'production' MODE, including Vercel preview
  // deploys, so MODE alone can't separate them. VERCEL_ENV can ('production' |
  // 'preview' | 'development'); vite.config.ts forwards it as
  // VITE_VERCEL_ENV since Vite only exposes VITE_-prefixed vars. Fall back to
  // the MODE check for local dev and any non-Vercel build, where
  // VITE_VERCEL_ENV is unset.
  const vercelEnv = import.meta.env.VITE_VERCEL_ENV
  posthog.register({
    environment: vercelEnv || (import.meta.env.MODE === 'production' ? 'production' : 'development')
  })
  initialised = true
  return true
}

export function trackLandingPageView(pathname: string, search = ''): void {
  if (!init()) return
  posthog.capture('$pageview', createLandingPageViewData(pathname, search))
}

export function trackLandingEvent(name: LandingEventName, target: string): void {
  if (!init()) return
  posthog.capture(
    name,
    createLandingEventData(target, window.location.pathname, window.location.search)
  )
}

// Autocapture only sees exceptions that reach the top. Anything we catch and
// turn into a friendly message has to be reported by hand, or the failure goes
// dark in Error Tracking.
export function trackLandingException(error: unknown, context: string): void {
  if (!init()) return
  posthog.captureException(error, { context })
}
