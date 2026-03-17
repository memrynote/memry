import { useState, useCallback, useEffect, useMemo } from 'react'
import {
  Trash2,
  CheckSquare,
  FileText,
  FolderOpen,
  Clock,
  ExternalLink,
  BellOff
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { TriageFilePicker } from './triage-file-picker'
import { TriageSnoozePicker } from './triage-snooze-picker'
import type { FileItemInput, SnoozeInput } from '@/services/inbox-service'
import type { InboxItemType } from '@memry/contracts/inbox-api'

type ActivePicker = 'file' | 'snooze' | null

interface TriageActionBarProps {
  itemId: string
  itemType?: InboxItemType
  onDiscard: () => void
  onConvertToTask: () => void
  onExpandToNote: () => void
  onFile: (input: FileItemInput) => void
  onDefer: (input: SnoozeInput) => void
  onDismissReminder?: () => void
  onOpenTarget?: () => void
  disabled?: boolean
}

interface ActionDef {
  key: string
  label: string
  icon: React.ReactNode
  picker?: ActivePicker
  action?: () => void
  variant?: 'destructive'
}

export function TriageActionBar({
  itemId,
  itemType,
  onDiscard,
  onConvertToTask,
  onExpandToNote,
  onFile,
  onDefer,
  onDismissReminder,
  onOpenTarget,
  disabled = false
}: TriageActionBarProps): React.JSX.Element {
  const [activePicker, setActivePicker] = useState<ActivePicker>(null)

  const closePicker = useCallback(() => setActivePicker(null), [])

  const isReminder = itemType === 'reminder'

  const actions: ActionDef[] = useMemo(() => {
    if (isReminder) {
      return [
        {
          key: 'D',
          label: 'Dismiss',
          icon: <BellOff className="size-4" />,
          action: onDismissReminder ?? onDiscard
        },
        {
          key: 'O',
          label: 'Open',
          icon: <ExternalLink className="size-4" />,
          action: onOpenTarget
        },
        {
          key: 'S',
          label: 'Snooze',
          icon: <Clock className="size-4" />,
          picker: 'snooze' as ActivePicker
        }
      ]
    }

    return [
      {
        key: 'D',
        label: 'Discard',
        icon: <Trash2 className="size-4" />,
        action: onDiscard,
        variant: 'destructive' as const
      },
      {
        key: 'T',
        label: 'Task',
        icon: <CheckSquare className="size-4" />,
        action: onConvertToTask
      },
      { key: 'N', label: 'Note', icon: <FileText className="size-4" />, action: onExpandToNote },
      {
        key: 'F',
        label: 'File',
        icon: <FolderOpen className="size-4" />,
        picker: 'file' as ActivePicker
      },
      {
        key: 'S',
        label: 'Snooze',
        icon: <Clock className="size-4" />,
        picker: 'snooze' as ActivePicker
      }
    ]
  }, [isReminder, onDiscard, onConvertToTask, onExpandToNote, onDismissReminder, onOpenTarget])

  useEffect(() => {
    if (disabled) return

    const handler = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

      const key = e.key.toUpperCase()

      if (key === 'ESCAPE' && activePicker) {
        e.preventDefault()
        closePicker()
        return
      }

      const action = actions.find((a) => a.key === key)
      if (!action) return

      e.preventDefault()
      if (action.picker) {
        setActivePicker(action.picker === activePicker ? null : action.picker)
      } else if (action.action) {
        action.action()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [disabled, activePicker, actions, closePicker])

  const handleFolderSelect = (folder: { path?: string }): void => {
    onFile({
      itemId,
      destination: { type: 'folder', path: folder.path || '' }
    })
    closePicker()
  }

  const handleNoteLink = (noteId: string): void => {
    onFile({
      itemId,
      destination: { type: 'note', noteId }
    })
    closePicker()
  }

  const handleSnoozeSelect = (snoozeUntil: string): void => {
    onDefer({ itemId, snoozeUntil })
    closePicker()
  }

  return (
    <div className="border-t px-6 py-4">
      {activePicker === 'file' && (
        <div className="mb-4">
          <TriageFilePicker
            itemId={itemId}
            onSelect={handleFolderSelect}
            onLinkToNote={handleNoteLink}
            onCancel={closePicker}
          />
        </div>
      )}

      {activePicker === 'snooze' && (
        <div className="mb-4">
          <TriageSnoozePicker onSelect={handleSnoozeSelect} onCancel={closePicker} />
        </div>
      )}

      <div className="flex items-center justify-center gap-2">
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            disabled={disabled}
            onClick={() => {
              if (action.picker) {
                setActivePicker(action.picker === activePicker ? null : action.picker)
              } else if (action.action) {
                action.action()
              }
            }}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors',
              'disabled:pointer-events-none disabled:opacity-50',
              action.variant === 'destructive'
                ? 'hover:bg-destructive/10 hover:text-destructive text-muted-foreground'
                : action.picker === activePicker
                  ? 'bg-accent text-foreground'
                  : 'hover:bg-accent text-muted-foreground hover:text-foreground'
            )}
          >
            {action.icon}
            <span>{action.label}</span>
            <kbd className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-mono">
              {action.key}
            </kbd>
          </button>
        ))}
      </div>
    </div>
  )
}
