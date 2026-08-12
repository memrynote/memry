/**
 * Type selector — inbox detail panel.
 *
 * Segmented control choosing what the captured item becomes:
 * Note (file to a folder) · Task · Event · Reminder. Replaces the old bottom
 * "Convert" row; the selection drives the panel body and primary action.
 * Note-only items (image/pdf/video/clip) have nothing to choose, so the panel
 * hides this control for them rather than rendering a one-option group.
 */

import { useId } from 'react'
import { LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { FileText, ListTodo, CalendarClock, Bell } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

import { cn } from '@/lib/utils'
import type { ConvertType } from './convert-types'

interface TypeSelectorProps {
  value: ConvertType
  onChange: (type: ConvertType) => void
}

const OPTIONS: { type: ConvertType; icon: React.ReactNode }[] = [
  { type: 'note', icon: <FileText className="size-3.5" aria-hidden="true" /> },
  { type: 'task', icon: <ListTodo className="size-3.5" aria-hidden="true" /> },
  { type: 'event', icon: <CalendarClock className="size-3.5" aria-hidden="true" /> },
  { type: 'reminder', icon: <Bell className="size-3.5" aria-hidden="true" /> }
]

export const TypeSelector = ({ value, onChange }: TypeSelectorProps): React.JSX.Element => {
  const { t } = useT('inbox')
  const prefersReducedMotion = useReducedMotion()
  const layoutGroupId = useId()

  return (
    <LayoutGroup id={layoutGroupId}>
      <div
        role="radiogroup"
        aria-label={t('convert.chooseType')}
        className="grid grid-cols-4 gap-1 p-1 rounded-md bg-foreground/[0.03] border border-border"
      >
        {OPTIONS.map((opt) => {
          const selected = value === opt.type
          return (
            <span key={opt.type} className="flex">
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChange(opt.type)}
                className={cn(
                  'relative flex w-full items-center justify-center gap-1.5 rounded-sm py-1.5 text-[12px]',
                  'transition-colors duration-150 active:scale-[0.97]',
                  selected
                    ? 'text-[var(--tint)] font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {selected && (
                  <motion.span
                    layoutId="type-selector-pill"
                    aria-hidden="true"
                    transition={
                      prefersReducedMotion
                        ? { duration: 0 }
                        : { type: 'spring', bounce: 0, duration: 0.3 }
                    }
                    className="absolute inset-0 rounded-sm bg-[var(--tint)]/10"
                  />
                )}
                <span className="relative z-10 flex items-center gap-1.5">
                  {opt.icon}
                  {t(`convert.${opt.type}`)}
                </span>
              </button>
            </span>
          )
        })}
      </div>
    </LayoutGroup>
  )
}
