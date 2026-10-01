import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
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
 * Stashed items keep their formatting: they render through the editor schema
 * and drag or copy as the editor's clipboard HTML, which ProseMirror's own drop
 * and paste handling turns back into the same nodes and marks.
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
                render={() => session.renderOverflow(item)}
                onDelete={() => session.removeOverflow(item.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

interface OverflowRowProps {
  item: WritingOverflowItem
  /** The item through the editor schema; null for plain-text items */
  render: () => HTMLElement | DocumentFragment | null
  onDelete: () => void
}

function OverflowRow({ item, render, onDelete }: OverflowRowProps) {
  const { t } = useT('notes')
  const contentRef = useRef<HTMLDivElement>(null)
  const [formatted, setFormatted] = useState(false)

  useLayoutEffect(() => {
    const element = contentRef.current
    if (!element) return
    const fragment = render()
    element.replaceChildren(...(fragment ? [fragment] : []))
    setFormatted(fragment !== null)
    // `render` is a fresh closure every snapshot; the item's HTML is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.html])

  const copy = async (): Promise<void> => {
    try {
      if (item.html) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([item.html], { type: 'text/html' }),
            'text/plain': new Blob([item.text], { type: 'text/plain' })
          })
        ])
      } else {
        await navigator.clipboard.writeText(item.text)
      }
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
        if (item.html) event.dataTransfer.setData('text/html', item.html)
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
        <div
          ref={contentRef}
          className="writing-overflow-content break-words text-sm"
          hidden={!formatted}
        />
        {!formatted && <p className="whitespace-pre-wrap break-words text-sm">{item.text}</p>}
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
