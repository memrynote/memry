import { useAppCommands } from '@/commands'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { windowApi } from '@/services/window-service'
import { clampZoomFactor, stepZoomFactor, ZOOM_FACTOR_DEFAULT } from '@memry/contracts/app-zoom'

/**
 * The owner of `view.zoomIn`, `view.zoomOut` and `view.actualSize`, the single
 * place that sets the app-wide zoom. The keystrokes (⌘0 / ⌘= / ⌘- and the ⌘+
 * alias) and the View menu items reach it through `runCommand`; the chords are
 * rebindable from Settings → Shortcuts.
 */
export function useAppZoom(): void {
  const { settings, isLoading, updateSettings } = useGeneralSettings()

  const zoomFactor = clampZoomFactor(settings.zoomFactor)

  // Applied before the write is awaited so the keystroke lands instantly; the
  // settings round trip only has to catch up before the next launch.
  const applyZoom = async (factor: number): Promise<void> => {
    // `settings` holds the defaults until the first read resolves, so a ⌘+ in
    // that window would step from 100% and persist it over whatever the user
    // actually saved. Dropping the command is the only harmless option.
    if (isLoading) return
    windowApi.setZoomFactor(factor)
    await updateSettings({ zoomFactor: factor })
  }

  useAppCommands('zoom', {
    'view.zoomIn': { run: () => applyZoom(stepZoomFactor(zoomFactor, 1)) },
    'view.zoomOut': { run: () => applyZoom(stepZoomFactor(zoomFactor, -1)) },
    'view.actualSize': { run: () => applyZoom(ZOOM_FACTOR_DEFAULT) }
  })
}
