/**
 * Ask the app shell to open Settings from code that renders outside
 * `SettingsModalProvider` (the sync provider's toasts, for one).
 *
 * `section` takes the same targets as `useSettingsModal().open`, including the
 * `section:focus` forms such as `vault:activity`.
 *
 * @module lib/settings-navigation
 */

const OPEN_SETTINGS_EVENT = 'memry:open-settings'

export function requestOpenSettings(section: string): void {
  window.dispatchEvent(new CustomEvent<string>(OPEN_SETTINGS_EVENT, { detail: section }))
}

export function onOpenSettingsRequested(callback: (section: string) => void): () => void {
  const listener = (event: Event): void => {
    const section = (event as CustomEvent<unknown>).detail
    if (typeof section === 'string') callback(section)
  }
  window.addEventListener(OPEN_SETTINGS_EVENT, listener)
  return () => window.removeEventListener(OPEN_SETTINGS_EVENT, listener)
}
