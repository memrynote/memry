import { useEffect } from 'react'
import { useT } from '@memry/i18n/renderer'

import { commands } from '../../../generated/bindings'

type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

const EDIT_ITEMS: ReadonlyArray<{ id: EditCommand; key: string }> = [
  { id: 'undo', key: 'edit.undo' },
  { id: 'redo', key: 'edit.redo' },
  { id: 'cut', key: 'edit.cut' },
  { id: 'copy', key: 'edit.copy' },
  { id: 'paste', key: 'edit.paste' },
  { id: 'selectAll', key: 'edit.selectAll' }
]

/** A plain input or textarea, not the note editor (which has its own menu in Step 11). */
function plainEditableField(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.ProseMirror, [data-memry-native-menu="off"]')) return false
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  )
}

/**
 * WebView2 and WKWebView already show a native edit menu over a text field; WebKitGTK shows
 * none. On Linux only, this builds Undo, Redo, Cut, Copy, Paste and Select All with the enabled
 * flags `document.queryCommandEnabled` reports.
 */
export function useNativeEditMenu(): void {
  const { t } = useT('menu')
  useEffect(() => {
    if (document.documentElement.getAttribute('data-platform') !== 'linux') return undefined
    const onContextMenu = (event: MouseEvent): void => {
      if (!plainEditableField(event.target)) return
      event.preventDefault()
      const items = [
        ...EDIT_ITEMS.slice(0, 2),
        { id: 'sep-1', label: '', type: 'separator' as const, accelerator: null, disabled: null },
        ...EDIT_ITEMS.slice(2, 5),
        { id: 'sep-2', label: '', type: 'separator' as const, accelerator: null, disabled: null },
        EDIT_ITEMS[5]
      ].map((item) =>
        'key' in item
          ? {
              id: item.id,
              label: t(item.key),
              accelerator: null,
              type: 'normal' as const,
              // No replacement exists for driving the page's own edit commands.
              // oxlint-disable-next-line typescript/no-deprecated
              disabled: !document.queryCommandEnabled(
                item.id === 'selectAll' ? 'selectAll' : item.id
              )
            }
          : item
      )
      void commands.shellShowContextMenu(items).then((chosen) => {
        if (chosen && EDIT_ITEMS.some((item) => item.id === chosen)) {
          // oxlint-disable-next-line typescript/no-deprecated
          document.execCommand(chosen)
        }
      })
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [t])
}
