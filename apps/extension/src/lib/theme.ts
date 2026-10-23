export type Theme = 'light' | 'dark'

export const STORAGE_KEY = 'memry-theme'

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function storedTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY)
  return saved === 'light' || saved === 'dark' ? saved : systemTheme()
}

// Called once in main.tsx before render so a saved choice paints with no flash.
export function applyStoredTheme(): void {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved
}
