import { ThemeProvider } from 'next-themes'
import QuickCapture from './components/quick-capture'
import { AISettingsProvider } from './contexts/ai-settings-context'
import { getStartupTheme, THEME_STORAGE_KEY } from './lib/startup-theme'

const startupTheme = getStartupTheme()

/**
 * The quick capture window's tree below the providers every window shares
 * (main.tsx). Loaded by main.tsx only for `#/quick-capture`, so the main window
 * never evaluates QuickCapture.
 */
export function QuickCaptureRoot(): React.JSX.Element {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme={startupTheme}
      enableSystem
      themes={['light', 'dark', 'white', 'system']}
      storageKey={THEME_STORAGE_KEY}
    >
      <AISettingsProvider>
        <QuickCapture />
      </AISettingsProvider>
    </ThemeProvider>
  )
}
