import { useEffect, useMemo } from 'react'
import { isInputFocused } from '@/hooks/use-keyboard-shortcuts'
import {
  Trash2,
  CheckSquare,
  FileText,
  FolderOpen,
  Clock,
  ExternalLink,
  Archive03
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { InboxItemType } from '@memry/contracts/inbox-api'

export type ActivePicker = 'file' | 'snooze' | null

interface TriageActionBarProps {
  itemType?: InboxItemType
  activePicker: ActivePicker
  onPickerChange: (picker: ActivePicker) => void
  onDiscard: () => void
  onConvertToTask: () => void
  onExpandToNote: () => void
  onOpenTarget?: () => void
  disabled?: boolean
}

interface ActionDef {
  key: string
  label: string
  icon: React.ReactNode
  colorVar: string
  picker?: ActivePicker
  action?: () => void
}

const ACTION_STYLES = {
  discard: 'var(--destructive)',
  task: 'var(--accent-purple)',
  note: 'var(--accent-green)',
  file: 'var(--accent-orange)',
  snooze: 'var(--accent-cyan)',
  archive: 'var(--muted-foreground)',
  open: 'var(--accent-purple)'
} as const

export function TriageActionBar({
  itemType,
  activePicker,
  onPickerChange,
  onDiscard,
  onConvertToTask,
  onExpandToNote,
  onOpenTarget,
  disabled = false
}: TriageActionBarProps): React.JSX.Element {
  const isReminder = itemType === 'reminder'

  const actions: ActionDef[] = useMemo(() => {
    if (isReminder) {
      return [
        {
          key: 'D',
          label: 'Archive',
          icon: <Archive03 className="size-5" />,
          colorVar: ACTION_STYLES.archive,
          action: onDiscard
        },
        {
          key: 'O',
          label: 'Open',
          icon: <ExternalLink className="size-5" />,
          colorVar: ACTION_STYLES.open,
          action: onOpenTarget
        }
      ]
    }

    return [
      {
        key: 'D',
        label: 'Discard',
        icon: <Trash2 className="size-5" />,
        colorVar: ACTION_STYLES.discard,
        action: onDiscard
      },
      {
        key: 'T',
        label: 'To Task',
        icon: <CheckSquare className="size-5" />,
        colorVar: ACTION_STYLES.task,
        action: onConvertToTask
      },
      {
        key: 'N',
        label: 'To Note',
        icon: <FileText className="size-5" />,
        colorVar: ACTION_STYLES.note,
        action: onExpandToNote
      },
      {
        key: 'F',
        label: 'File',
        icon: <FolderOpen className="size-5" />,
        colorVar: ACTION_STYLES.file,
        picker: 'file' as ActivePicker
      },
      {
        key: 'S',
        label: 'Snooze',
        icon: <Clock className="size-5" />,
        colorVar: ACTION_STYLES.snooze,
        picker: 'snooze' as ActivePicker
      }
    ]
  }, [isReminder, onDiscard, onConvertToTask, onExpandToNote, onOpenTarget])

  useEffect(() => {
    if (disabled) return

    const handler = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (isInputFocused()) return

      const key = e.key.toUpperCase()

      if (key === 'ESCAPE' && activePicker) {
        e.preventDefault()
        onPickerChange(null)
        return
      }

      const action = actions.find((a) => a.key === key)
      if (!action) return

      e.preventDefault()
      if (action.picker) {
        onPickerChange(action.picker === activePicker ? null : action.picker)
      } else if (action.action) {
        action.action()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [disabled, activePicker, actions, onPickerChange])

  return (
    <div className="flex shrink-0 items-center justify-center gap-4 px-8 pt-6 pb-10">
      {actions.map((action) => {
        const isPickerActive = action.picker && action.picker === activePicker
        return (
          <button
            key={action.key}
            type="button"
            disabled={disabled}
            onClick={() => {
              if (action.picker) {
                onPickerChange(action.picker === activePicker ? null : action.picker)
              } else if (action.action) {
                action.action()
              }
            }}
            className={cn(
              'flex w-[100px] flex-col items-center gap-2 transition-opacity',
              'disabled:pointer-events-none disabled:opacity-50'
            )}
          >
            <div
              className={cn(
                'flex size-[52px] items-center justify-center rounded-[14px] border transition-colors',
                isPickerActive && 'ring-2 ring-offset-2 ring-offset-background'
              )}
              style={{
                color: action.colorVar,
                backgroundColor: `color-mix(in srgb, ${action.colorVar} 6%, transparent)`,
                borderColor: `color-mix(in srgb, ${action.colorVar} 25%, transparent)`,
                ...(isPickerActive ? { ringColor: action.colorVar } : {})
              }}
            >
              {action.icon}
            </div>
            <span className="text-[11px]/3.5 font-medium" style={{ color: action.colorVar }}>
              {action.label}
            </span>
            <span className="text-[10px]/3 text-text-tertiary">{action.key}</span>
          </button>
        )
      })}
    </div>
  )
}
