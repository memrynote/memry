export const WAITLIST_CAMPAIGNS = {
  launchPlain: 'waitlist_01',
  scatteredWorkflow: 'waitlist_02',
  productPreview: 'waitlist_03',
  workflow: 'waitlist_04',
  localFirstAi: 'waitlist_05',
  launchWeek: 'waitlist_06',
  launchDay: 'waitlist_07',
  gettingStarted: 'waitlist_08',
  useCases: 'waitlist_09',
  feedback: 'waitlist_10',
  lastCall: 'waitlist_11',
  welcome: 'waitlist_welcome',
  migrationGuide: 'waitlist_migration',
  syncConversion: 'waitlist_sync_conversion',
  tasksDeepDive: 'waitlist_tasks_deep_dive',
  openBeta: 'open_beta_launch',
  betaUpdateAugust: 'beta_update_2026_08'
} as const

export type WaitlistCampaignId = (typeof WAITLIST_CAMPAIGNS)[keyof typeof WAITLIST_CAMPAIGNS]

export function trackedMemryUrl(
  path: string,
  campaign: WaitlistCampaignId,
  content: string
): string {
  const url = new URL(path, 'https://memrynote.com')

  url.searchParams.set('utm_source', 'waitlist')
  url.searchParams.set('utm_medium', 'email')
  url.searchParams.set('utm_campaign', campaign)
  url.searchParams.set('utm_content', content)

  return url.toString()
}
