import type { RefObject } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useTabCommands } from '@/commands'

interface CanvasCommandOwnerProps {
  /** Filled by the card layer with the function that opens its "Add card" picker. */
  openAddCardRef: RefObject<(() => void) | null>
  openLayout: () => void
  openLinkPicker: () => void
}

/**
 * The owner of every `canvas.*` command. A component rather than a hook because
 * the editor also draws a board inside a note, which must not register commands
 * on the note's tab: only a canvas tab renders this. Each command opens the
 * dialog the board's own button or key opens.
 */
export function CanvasCommandOwner({
  openAddCardRef,
  openLayout,
  openLinkPicker
}: CanvasCommandOwnerProps): null {
  const { t } = useT('common')

  useTabCommands('canvas', {
    'canvas.addCard': { label: t('canvas.card.addCard'), run: () => openAddCardRef.current?.() },
    'canvas.layoutByProperty': { label: t('canvas.frame.layoutAction'), run: openLayout },
    'canvas.linkToItem': { label: t('canvas.link.title'), run: openLinkPicker }
  })
  return null
}
