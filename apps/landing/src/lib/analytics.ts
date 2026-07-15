import { SYNC_SERVER_URL } from './account/config'

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
  | 'utm_source'
  | 'utm_medium'
  | 'utm_campaign'
  | 'utm_content'
  | 'utm_term'

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

// Anonymous, fire-and-forget events → sync-server /telemetry/web → Cloudflare
// Analytics Engine. Privacy: fixed event names, path-only pages, slug targets,
// UTM params — no PII, no free-form strings. Errors are always swallowed so
// analytics can never break the page.
const TELEMETRY_ENDPOINT = `${SYNC_SERVER_URL}/telemetry/web`
const VISITOR_ID_STORAGE_KEY = 'memry_landing_visitor_id'
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let inMemoryVisitorId: string | undefined

function getVisitorId(): string {
  try {
    const existing = window.localStorage.getItem(VISITOR_ID_STORAGE_KEY)
    if (existing && UUID_VALUE.test(existing)) return existing
    const created = crypto.randomUUID()
    window.localStorage.setItem(VISITOR_ID_STORAGE_KEY, created)
    return created
  } catch {
    // localStorage unavailable (private mode, blocked cookies) — session-scoped id
    inMemoryVisitorId ??= crypto.randomUUID()
    return inMemoryVisitorId
  }
}

function sendLandingEvent(event: { name: string } & Partial<LandingEventData>): void {
  if (typeof window === 'undefined') return
  try {
    const payload = JSON.stringify({ visitorId: getVisitorId(), events: [event] })
    // A plain-string beacon posts as text/plain (no CORS preflight); the server
    // parses the body as JSON regardless of content type.
    if (navigator.sendBeacon?.(TELEMETRY_ENDPOINT, payload)) return
    void fetch(TELEMETRY_ENDPOINT, { method: 'POST', keepalive: true, body: payload }).catch(
      () => {}
    )
  } catch {
    // never let analytics throw into the page
  }
}

export function trackLandingPageView(pathname: string, search = ''): void {
  sendLandingEvent({ name: 'landing_page_view', ...createLandingPageViewData(pathname, search) })
}

export function trackLandingEvent(name: LandingEventName, target: string): void {
  if (typeof window === 'undefined') return
  sendLandingEvent({
    name,
    ...createLandingEventData(target, window.location.pathname, window.location.search)
  })
}
