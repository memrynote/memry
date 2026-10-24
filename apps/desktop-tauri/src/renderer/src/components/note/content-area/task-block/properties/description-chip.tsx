import { useCallback, useEffect, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import { TextAlignLeft } from '@/lib/icons'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TaskDescriptionEditor } from '@/components/tasks/task-description-editor'
import { PropertyChip, stopKeyPropagation } from './property-chip'
import { shortcutLabelFor, type TaskPropertyOpenState } from './task-property-ids'

/** Same pace as the drawer: one write per pause, not one per keystroke. */
const SAVE_DEBOUNCE_MS = 500

interface DescriptionChipProps extends TaskPropertyOpenState {
  taskId: string
  description: string
  onChange: (description: string) => void
}

const firstLine = (markdown: string): string =>
  markdown
    .split('\n')
    .map((line) => line.replace(/^[#>*\-\s\d.[\]]+/, '').trim())
    .find(Boolean) ?? ''

/**
 * An icon-only chip that says "this task has notes"; its tooltip previews the
 * first line. The popover is the drawer's description editor, saved on a
 * debounce and flushed when it closes.
 */
export const DescriptionChip = ({
  taskId,
  description,
  onChange,
  open,
  onOpenChange
}: DescriptionChipProps): React.JSX.Element | null => {
  const { t } = useT('tasks')
  const pendingRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (pendingRef.current !== null) {
      onChange(pendingRef.current)
      pendingRef.current = null
    }
  }, [onChange])

  // An edit still waiting on its debounce is written when the block goes away.
  useEffect(() => flush, [flush])

  const handleContentChange = useCallback(
    (markdown: string) => {
      pendingRef.current = markdown
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
    },
    [flush]
  )

  const isOpen = open === 'description'
  const hasDescription = description.trim() !== ''
  if (!hasDescription && !isOpen) return null

  const preview = firstLine(description)

  return (
    <Popover
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) flush()
        onOpenChange('description', next)
      }}
    >
      <PopoverTrigger asChild>
        <PropertyChip
          icon={<TextAlignLeft className="size-3 shrink-0" aria-hidden="true" />}
          aria-label={preview ? `${t('task.description')}: ${preview}` : t('task.description')}
          title={`${preview || t('task.description')} · ${shortcutLabelFor('description')}`}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex max-h-[min(360px,var(--radix-popover-content-available-height))] w-[360px] flex-col overflow-y-auto p-3"
        onKeyDown={stopKeyPropagation}
      >
        <TaskDescriptionEditor
          key={taskId}
          initialContent={description}
          onContentChange={handleContentChange}
          placeholder={t('task.descriptionPlaceholder')}
          ariaLabel={t('task.description')}
          className="text-[13px] leading-5 text-text-primary"
        />
      </PopoverContent>
    </Popover>
  )
}
