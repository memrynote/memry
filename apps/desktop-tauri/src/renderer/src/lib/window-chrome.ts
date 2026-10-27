import { useEffect, useSyncExternalStore } from 'react'

import { events } from '../../../generated/bindings'
import { subscribeToEvent } from '../services/tauri-event'

const root = (): HTMLElement => document.documentElement

/** Windows draws its own caption buttons (`components/caption-buttons.tsx`). */
export const isCaptionPlatform = (): boolean => root().getAttribute('data-platform') === 'win32'

/**
 * Mirrors `WindowChromeStateChangedEvent` onto `<html data-fullscreen>`. The caption buttons
 * hide in fullscreen, and `--caption-reserve-end` (main.css) follows the attribute.
 */
export function useWindowChromeSync(): void {
  useEffect(
    () =>
      subscribeToEvent(events.windowChromeStateChangedEvent, ({ fullscreen }) => {
        if (fullscreen) root().setAttribute('data-fullscreen', '')
        else root().removeAttribute('data-fullscreen')
      }),
    []
  )
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(root(), { attributes: true, attributeFilter: ['data-fullscreen'] })
  return () => observer.disconnect()
}

const captionButtonsShown = (): boolean =>
  isCaptionPlatform() && !root().hasAttribute('data-fullscreen')

/** True while the caption buttons cover the end of the title row. */
export function useCaptionButtonsVisible(): boolean {
  return useSyncExternalStore(subscribe, captionButtonsShown, () => false)
}
