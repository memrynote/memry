/**
 * The renderer's record of the tour. Older app versions read only this one, so it
 * is still written and a downgrade does not show the tour again.
 */
export const TOUR_KEY = 'memry:onboarding:tour:v1'

/** Marks this install and vault as past onboarding, so the tour does not run. */
export async function recordOnboarded(): Promise<void> {
  localStorage.setItem(TOUR_KEY, '1')
  await window.api.settings.setGeneralSettings({ onboardingCompleted: true })
}
