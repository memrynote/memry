import { useState, type KeyboardEvent } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { WritingOverflowItem } from '@memry/shared'
import { Copy, GripVertical, Trash2 } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { WritingToolsSession, WritingToolsSnapshot } from './writing-tools-session'

interface OverflowRailProps {
  session: WritingToolsSession
  snapshot: WritingToolsSnapshot
}

/**
 * The note's overflow list: lines kept with the note but out of its text.
 * Items drag into the editor as plain text (ProseMirror's own drop handling
 * inserts them at the drop point).
 */
export function OverflowRail({ session, snapshot }: OverflowRailProps) {
  const { t } = useT('notes')
  const [value, setValue] = useState('')

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (!value.trim()) return
    session.addOverflow(value)
    setValue('')
  }

  return (
    <aside
      aria-label={t('writingTools.overflow.railAria')}
      data-marquee-ignore
      className="review-rail"
    >
      <div className="review-rail-inner writing-rail-panel">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('writingTools.overflow.addPlaceholder')}
          aria-label={t('writingTools.overflow.addPlaceholder')}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm placeholder:text-text-tertiary focus-visible:border-ring focus-visible:outline-none"
        />
        {snapshot.overflow.length === 0 ? (
          <p className="writing-rail-empty">{t('writingTools.overflow.empty')}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {snapshot.overflow.map((item) => (
              <OverflowRow
                key={item.id}
                item={item}
                onDelete={() => session.removeOverflow(item.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

function OverflowRow({ item, onDelete }: { item: WritingOverflowItem; onDelete: () => void }) {
  const { t } = useT('notes')

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(item.text)
      toast.success(t('writingTools.overflow.copied'))
    } catch (error) {
      toast.error(extractErrorMessage(error, t('writingTools.menu.clipboardFailed')))
    }
  }

  return (
    <li
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', item.text)
        event.dataTransfer.effectAllowed = 'copy'
      }}
      className="writing-overflow-item group/item"
      title={t('writingTools.overflow.dragHint')}
    >
      <GripVertical
        className="mt-0.5 size-3.5 shrink-0 cursor-grab text-text-tertiary"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        {item.label && <p className="text-xs text-text-tertiary">{item.label}</p>}
        <p className="whitespace-pre-wrap break-words text-sm">{item.text}</p>
      </div>
      <div className="flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity group-hover/item:opacity-100 group-focus-within/item:opacity-100 motion-reduce:transition-none">
        <button
          type="button"
          aria-label={t('writingTools.overflow.copy')}
          className="rounded p-1 text-text-tertiary hover:bg-surface-active hover:text-foreground"
          onClick={() => void copy()}
        >
          <Copy className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={t('writingTools.overflow.delete')}
          className="rounded p-1 text-text-tertiary hover:bg-surface-active hover:text-foreground"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </li>
  )
}
