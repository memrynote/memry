import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts-base'
import { clampZoomFactor, stepZoomFactor, ZOOM_FACTOR_DEFAULT } from '@memry/contracts/app-zoom'

export interface AppZoomActions {
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
}

/**
 * The single owner of the app-wide zoom, reached two ways: the View menu items
 * and the ⌘0 / ⌘+ / ⌘- keystrokes bound here.
 *
 * The keystrokes are the renderer's rather than registered native accelerators
 * because every other shortcut in the app already lives at this layer, and it
 * is the only layer that can be tested.
 */
export function useAppZoom(): AppZoomActions {
  const { settings, isLoading, updateSettings } = useGeneralSettings()

  const zoomFactor = clampZoomFactor(settings.zoomFactor)

  // Applied before the write is awaited so the keystroke lands instantly; the
  // settings round trip only has to catch up before the next launch.
  const applyZoom = async (factor: number): Promise<void> => {
    // `settings` holds the defaults until the first read resolves, so a ⌘+ in
    // that window would step from 100% and persist it over whatever the user
    // actually saved. Dropping the keystroke is the only harmless option.
    if (isLoading) return
    window.api.setZoomFactor(factor)
    await updateSettings({ zoomFactor: factor })
  }

  const zoomIn = (): void => void applyZoom(stepZoomFactor(zoomFactor, 1))
  const zoomOut = (): void => void applyZoom(stepZoomFactor(zoomFactor, -1))
  const resetZoom = (): void => void applyZoom(ZOOM_FACTOR_DEFAULT)

  useKeyboardShortcuts(
    [
      {
        key: '=',
        modifiers: { meta: true },
        action: zoomIn,
        description: 'Zoom in',
        allowInInput: true
      },
      // On most layouts `+` is Shift+`=`, and the matcher rejects a held Shift
      // unless the chord asks for it.
      {
        key: '+',
        modifiers: { meta: true, shift: true },
        action: zoomIn,
        description: 'Zoom in',
        allowInInput: true
      },
      {
        key: '-',
        modifiers: { meta: true },
        action: zoomOut,
        description: 'Zoom out',
        allowInInput: true
      },
      {
        key: '0',
        modifiers: { meta: true },
        action: resetZoom,
        description: 'Actual size',
        allowInInput: true
      }
    ],
    // Zoom has to work with the caret in the note editor, which stops
    // propagation on its own keydowns.
    { capture: true }
  )

  return { zoomIn, zoomOut, resetZoom }
}
