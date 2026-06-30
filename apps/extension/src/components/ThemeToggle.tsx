import { useState } from 'react'

type Theme = 'light' | 'dark'

const STORAGE_KEY = 'memry-theme'

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function storedTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY)
  return saved === 'light' || saved === 'dark' ? saved : systemTheme()
}

// Called once in main.tsx before render so a saved choice paints with no flash.
export function applyStoredTheme(): void {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(storedTheme)
  const isDark = theme === 'dark'

  const toggle = () => {
    const next: Theme = isDark ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.dataset.theme = next
    localStorage.setItem(STORAGE_KEY, next)
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={isDark ? 'Switch to light' : 'Switch to dark'}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="-me-1 grid size-7 place-items-center rounded-md text-brand/70 transition-colors hover:bg-surface-active hover:text-brand"
    >
      {isDark ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="size-4"
          aria-hidden
        >
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="size-4"
          aria-hidden
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  )
}
