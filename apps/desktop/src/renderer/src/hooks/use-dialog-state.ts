import { useMemo, useState } from 'react'

export interface DialogState<D extends string> {
  show: (dialog: D) => void
  close: () => void
  is: (dialog: D) => boolean
  /** The `open` / `onOpenChange` pair of a dialog that follows Radix's controlled shape. */
  bind: (dialog: D) => { open: boolean; onOpenChange: (open: boolean) => void }
}

/**
 * Which one of a page's dialogs is open. A page's dialogs are modal, so at most
 * one shows; a menu item and a palette command both open one with `show`.
 */
export function useDialogState<D extends string>(): DialogState<D> {
  const [current, setCurrent] = useState<D | null>(null)
  return useMemo(
    () => ({
      show: (dialog) => {
        setCurrent(dialog)
      },
      close: () => {
        setCurrent(null)
      },
      is: (dialog) => current === dialog,
      // A dialog closing late must not close the one that replaced it.
      bind: (dialog) => ({
        open: current === dialog,
        onOpenChange: (open) => {
          setCurrent((now) => (open ? dialog : now === dialog ? null : now))
        }
      })
    }),
    [current]
  )
}
