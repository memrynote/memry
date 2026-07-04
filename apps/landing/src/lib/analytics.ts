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

// Analytics sink removed with PostHog. The tracking API is kept as no-ops so
// call sites stay intact; wire these to a self-hosted endpoint if landing
// traffic is needed again.
export function trackLandingPageView(pathname: string, search = ''): void {
  void pathname
  void search
}

export async function getLandingAnalyticsHeaders(): Promise<Record<string, string>> {
  return {}
}

export function trackLandingEvent(name: LandingEventName, target: string): void {
  void name
  void target
}
