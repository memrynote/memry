import { useT } from '@memry/i18n/renderer'
import { ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'

export function ResizeHandle({
  side,
  visible,
  onPointerDown
}: {
  side: 'start' | 'end'
  visible: boolean
  onPointerDown: (event: React.PointerEvent) => void
}): React.JSX.Element {
  return (
    <div
      data-testid={`timeline-resize-${side}`}
      onPointerDown={onPointerDown}
      className={cn(
        'absolute inset-y-0 z-10 flex w-2.5 cursor-ew-resize items-center justify-center',
        side === 'start' ? 'start-0' : 'end-0'
      )}
    >
      <span
        className={cn(
          'h-3 w-1 rounded-full bg-background shadow-[0_0_0_1px_var(--chip-rail)] transition-opacity duration-100',
          visible ? 'opacity-100' : 'opacity-0 group-hover/bar:opacity-100'
        )}
      />
    </div>
  )
}

/**
 * Chevron slot at the start of a parent task's list cell. The slot is always
 * 16px wide (20px in from the edge), so parents with and without subtasks
 * keep their status checkboxes aligned.
 */
export function SubtaskToggle({
  title,
  count,
  open,
  onToggle
}: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useT('calendar')
  return (
    <span
      className="relative flex size-4 shrink-0 items-center justify-center"
      style={{ marginInlineStart: 20 }}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {count > 0 && (
        <button
          type="button"
          data-testid="timeline-subtask-toggle"
          aria-expanded={open}
          aria-label={t(open ? 'timeline.subtasks.collapse' : 'timeline.subtasks.expand', {
            title,
            count
          })}
          onClick={onToggle}
          className="flex size-4 items-center justify-center rounded text-text-tertiary hover:bg-surface-active/60 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-3 transition-transform duration-150 ease-out',
              !open && '-rotate-90 rtl:rotate-90'
            )}
          />
        </button>
      )}
    </span>
  )
}
