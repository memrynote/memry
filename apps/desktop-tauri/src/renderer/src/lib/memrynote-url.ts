/** Where in the app a memrynote.com link lives. Keep a value once shipped (`marketing/utm.md`). */
type AppLinkCampaign = 'setup_wizard' | 'update_failed'

/**
 * A memrynote.com page with the app's UTM tags, so PostHog credits the visit to the desktop app
 * instead of "Direct". The checkout link is tagged where Rust builds it (`billing/service.rs`).
 */
export function memrynoteUrl(path: string, campaign: AppLinkCampaign): string {
  const url = new URL(path, 'https://memrynote.com')
  url.searchParams.set('utm_source', 'app')
  url.searchParams.set('utm_medium', 'desktop')
  url.searchParams.set('utm_campaign', campaign)
  return url.toString()
}
