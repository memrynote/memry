import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { setShortcutRecording } from '@/hooks/use-keyboard-shortcuts-base'
import {
  FOLDER_NOTE_SHORTCUT_PREFIX,
  SHORTCUT_REGISTRY,
  type ShortcutConflict
} from '@/lib/shortcut-registry'

export type SettingsT = ReturnType<typeof useT>['t']

export const KEYCAP =
  'h-auto min-w-0 rounded-none border-0 bg-transparent p-0 font-mono text-xs/4 font-normal text-muted-foreground'

export const PILL = 'flex items-center gap-0 rounded-full bg-muted px-2 py-0.5'

export const REBIND_BUTTON =
  'group/rebind flex items-center gap-2.5 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

export const PENCIL =
  'size-3.5 text-muted-foreground transition-colors group-hover/rebind:text-foreground'

export const ICON_BUTTON =
  'flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

export const QUIET_BUTTON =
  'rounded-sm text-xs/4 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

export const ROW =
  'relative grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_1.5rem] items-center gap-4 min-h-14 py-3 shrink-0 group'

export const RECORDING_ROW = '-mx-4 px-4 bg-tint-light'

export function RecordingBar(): React.JSX.Element {
  return <span aria-hidden="true" className="absolute inset-y-0 start-0 w-0.5 bg-tint" />
}

export const MODIFIER_KEYS = ['Meta', 'Control', 'Alt', 'Shift']

/**
 * One row's keystroke recorder. While it records, the app's own shortcuts stand
 * down (see `setShortcutRecording`), Escape or a click outside `captureRef`
 * cancels (`onCancel`), and every other keydown goes to `onKey`, which calls
 * `stop` once it has the chord it wants.
 */
export function useShortcutCapture(
  onKey: (e: KeyboardEvent, stop: () => void) => void,
  options: { initiallyCapturing?: boolean; onCancel?: () => void } = {}
): {
  isCapturing: boolean
  start: () => void
  stop: () => void
  cancel: () => void
  captureRef: React.RefObject<HTMLDivElement | null>
} {
  const [isCapturing, setIsCapturing] = useState(options.initiallyCapturing ?? false)
  const captureRef = useRef<HTMLDivElement>(null)
  const onKeyRef = useRef(onKey)
  const onCancelRef = useRef(options.onCancel)
  useEffect(() => {
    onKeyRef.current = onKey
    onCancelRef.current = options.onCancel
  })

  const start = useCallback(() => setIsCapturing(true), [])
  const stop = useCallback(() => setIsCapturing(false), [])
  const cancel = useCallback(() => {
    setIsCapturing(false)
    onCancelRef.current?.()
  }, [])

  useEffect(() => {
    if (!isCapturing) return
    setShortcutRecording(true)
    const handleKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        cancel()
        return
      }
      onKeyRef.current(e, () => setIsCapturing(false))
    }
    const handleMouseDown = (e: MouseEvent): void => {
      if (captureRef.current && !captureRef.current.contains(e.target as Node)) {
        cancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      setShortcutRecording(false)
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [isCapturing, cancel])

  return { isCapturing, start, stop, cancel, captureRef }
}

/** "Conflicts with: …", naming each shortcut the way its own row does. */
export function conflictMessage(t: SettingsT, conflicts: ShortcutConflict[]): string {
  const labels = conflicts.map((conflict) => {
    if (conflict.conflictingId.startsWith(FOLDER_NOTE_SHORTCUT_PREFIX)) {
      return t('shortcuts.folderNotes.conflictLabel', { folder: conflict.conflictingLabel })
    }
    const entry = SHORTCUT_REGISTRY.find((e) => e.id === conflict.conflictingId)
    return entry ? t(`shortcuts.entries.${entry.i18nKey}.label`) : conflict.conflictingLabel
  })
  return t('shortcuts.conflict', { labels: labels.join(', ') })
}
