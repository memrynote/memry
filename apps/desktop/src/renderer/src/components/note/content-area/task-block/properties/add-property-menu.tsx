import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Bell, Calendar, Hash, Link, Plus, Repeat, TextAlignLeft } from '@/lib/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import {
  resolvePropertyShortcut,
  shortcutLabelFor,
  type OptionalTaskPropertyId
} from './task-property-ids'

const ICON_CLASS = 'size-3.5 shrink-0 text-text-tertiary'

const ITEM_ICONS: Record<OptionalTaskPropertyId, React.JSX.Element> = {
  due: <Calendar size={14} className={ICON_CLASS} aria-hidden="true" />,
  start: <Calendar size={14} className={ICON_CLASS} aria-hidden="true" />,
  repeat: <Repeat className={ICON_CLASS} aria-hidden="true" />,
  reminder: <Bell className={ICON_CLASS} aria-hidden="true" />,
  tags: <Hash className={ICON_CLASS} aria-hidden="true" />,
  description: <TextAlignLeft className={ICON_CLASS} aria-hidden="true" />,
  related: <Link className={ICON_CLASS} aria-hidden="true" />
}

interface AddPropertyMenuProps {
  /** What the task is missing, in menu order. Empty renders nothing. */
  items: OptionalTaskPropertyId[]
  onPick: (id: OptionalTaskPropertyId) => void
  className?: string
}

/**
 * Labels only, no editors. Picking one closes the menu and opens that
 * property's chip in the same gesture, so the user learns in one go where the
 * property now lives. It lists only what the task lacks, so a fully specified
 * task has no `+` at all.
 */
export const AddPropertyMenu = ({
  items,
  onPick,
  className
}: AddPropertyMenuProps): React.JSX.Element | null => {
  const { t } = useT('tasks')
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null

  const labels: Record<OptionalTaskPropertyId, string> = {
    due: t('inlineProperties.dueDate'),
    start: t('task.startDate'),
    repeat: t('task.repeat'),
    reminder: t('inlineProperties.remindMe'),
    tags: t('task.tags'),
    description: t('task.description'),
    related: t('inlineProperties.linkItem')
  }

  // The chip's picker opens once the menu is gone: two Radix layers swapping
  // in the same frame fight over focus, and the newcomer loses.
  const pick = (id: OptionalTaskPropertyId): void => {
    setOpen(false)
    requestAnimationFrame(() => onPick(id))
  }

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('inlineProperties.addProperty')}
          title={t('inlineProperties.addProperty')}
          className={cn(
            'flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[5px]',
            'border border-dashed border-foreground/20 text-text-tertiary transition-colors',
            'hover:bg-surface-active hover:text-text-secondary data-[state=open]:bg-surface-active',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-text-tertiary',
            className
          )}
        >
          <Plus className="size-3" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          // The row's keys work here too: D in the menu is Due date.
          const id = resolvePropertyShortcut(event)
          if (id && (items as string[]).includes(id)) {
            event.preventDefault()
            event.stopPropagation()
            pick(id as OptionalTaskPropertyId)
          }
        }}
      >
        {items.map((id) => (
          <DropdownMenuItem key={id} onSelect={() => pick(id)} className="gap-2">
            {ITEM_ICONS[id]}
            <span className="flex-1 truncate">{labels[id]}</span>
            <Kbd className="h-4 min-w-4 text-[10px]">{shortcutLabelFor(id)}</Kbd>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
