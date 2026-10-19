import { useEffect } from 'react'
import type { StickyKind } from '@memry/contracts/sticky-api'
import { useT } from '@memry/i18n/renderer'
import { Check } from '@/lib/icons'

/** How long the confirmation stays before the sticky tucks itself away. */
const AUTO_TUCK_MS = 4000

interface StickySentProps {
  kind: StickyKind
  title: string
  canUndo: boolean
  modKey: string
  onOpen: () => void
  onUndo: () => void
  onDone: () => void
}

/** What a send created, with Open (⌘O) and, for notes and tasks, Undo (⌘Z). */
export function StickySent({
  kind,
  title,
  canUndo,
  modKey,
  onOpen,
  onUndo,
  onDone
}: StickySentProps): React.JSX.Element {
  const { t } = useT('inbox')

  useEffect(() => {
    const timer = window.setTimeout(onDone, AUTO_TUCK_MS)
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        onOpen()
      } else if (mod && e.key.toLowerCase() === 'z' && canUndo) {
        e.preventDefault()
        onUndo()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onDone()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [canUndo, onOpen, onUndo, onDone])

  return (
    <div role="status" className="flex flex-1 flex-col justify-center gap-3 px-5 py-4">
      <div className="flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded-full bg-black/[0.08]">
          <Check className="size-3" aria-hidden="true" />
        </span>
        <span className="text-[14px]/5 font-medium">{t(`sticky.sent.${kind}`)}</span>
      </div>
      {title && <p className="truncate text-[13px]/5 opacity-70">{title}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="no-drag rounded-md bg-[var(--tint)] px-2.5 py-1 text-[12px]/4 font-medium text-[var(--tint-foreground)] hover:bg-[var(--tint-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--tint)]"
        >
          {t('sticky.open')} <span className="opacity-70">{`${modKey}O`}</span>
        </button>
        {canUndo && (
          <button
            type="button"
            onClick={onUndo}
            className="no-drag rounded-md bg-black/[0.06] px-2.5 py-1 text-[12px]/4 font-medium hover:bg-black/[0.1] focus-visible:outline-2 focus-visible:outline-[var(--tint)]"
          >
            {t('sticky.undo')} <span className="opacity-60">{`${modKey}Z`}</span>
          </button>
        )}
      </div>
    </div>
  )
}
