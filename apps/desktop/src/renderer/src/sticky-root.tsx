import { ThemeProvider } from 'next-themes'
import { StickyCapture } from './components/sticky/sticky-capture'
import { useAppearanceSync } from './hooks/use-theme-sync'
import { getStartupTheme, THEME_STORAGE_KEY } from './lib/startup-theme'

const startupTheme = getStartupTheme()

function StickyWindow(): React.JSX.Element {
  useAppearanceSync()
  return <StickyCapture />
}

/**
 * The sticky window's tree below the providers every window shares
 * (main.tsx). Loaded by main.tsx only for `#/sticky`, so no other window
 * evaluates the sticky.
 */
export function StickyRoot(): React.JSX.Element {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme={startupTheme}
      enableSystem
      themes={['light', 'dark', 'white', 'system']}
      storageKey={THEME_STORAGE_KEY}
    >
      <StickyWindow />
    </ThemeProvider>
  )
}
