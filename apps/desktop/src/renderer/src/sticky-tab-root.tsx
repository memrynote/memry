import { ThemeProvider } from 'next-themes'
import { StickyEdgeTab } from './components/sticky/sticky-edge-tab'
import { useAppearanceSync } from './hooks/use-theme-sync'
import { getStartupTheme, THEME_STORAGE_KEY } from './lib/startup-theme'

const startupTheme = getStartupTheme()

function StickyTabWindow(): React.JSX.Element {
  useAppearanceSync()
  return <StickyEdgeTab />
}

/**
 * The edge tab window's tree below the providers every window shares
 * (main.tsx). Loaded by main.tsx only for `#/sticky-tab`.
 */
export function StickyTabRoot(): React.JSX.Element {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme={startupTheme}
      enableSystem
      themes={['light', 'dark', 'white', 'system']}
      storageKey={THEME_STORAGE_KEY}
    >
      <StickyTabWindow />
    </ThemeProvider>
  )
}
