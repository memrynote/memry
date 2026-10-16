import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { runMenuUpdateCheck } from '@/lib/menu-update-check'
import type { GeneralSettingsDTO } from '../../../preload/index.d'
import { useAppCommands } from './use-command-impls'
import { useEditorCommands } from './use-editor-commands'
import { useMenuBridge } from './use-menu-bridge'

/**
 * The owners of the commands that live outside any one page (window, theme,
 * editor), plus the bridge that turns native menu clicks into commands. Render
 * once, inside the tabs provider.
 */
export function AppCommandOwners(): null {
  const { t } = useT('settings')
  const { updateSettings } = useGeneralSettings()

  // The theme setting is the owner: `useThemeSync` applies it to next-themes. A
  // bare `setTheme` is overwritten by that sync a frame later.
  const setTheme = async (theme: GeneralSettingsDTO['theme']): Promise<void> => {
    if (!(await updateSettings({ theme }))) toast.error(t('appearance.theme.error'))
  }

  useAppCommands('window', {
    'app.checkForUpdates': { run: () => runMenuUpdateCheck() },
    'app.closeWindow': { run: () => window.api.windowClose() }
  })
  useAppCommands('appearance', {
    'view.themeLight': { run: () => setTheme('light') },
    'view.themeDark': { run: () => setTheme('dark') },
    'view.themeWhite': { run: () => setTheme('white') },
    'view.themeSystem': { run: () => setTheme('system') }
  })
  useEditorCommands()
  useMenuBridge()

  return null
}
