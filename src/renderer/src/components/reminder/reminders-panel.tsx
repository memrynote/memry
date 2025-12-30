/**
 * Reminders Panel Component
 *
 * A slide-in panel showing all reminders.
 * Includes a bell icon trigger with badge showing reminder count.
 *
 * @module components/reminder/reminders-panel
 */

import * as React from 'react'
import { useState, useCallback } from 'react'
import { Bell } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from '@/components/ui/sheet'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@/components/ui/tooltip'
import { RemindersList } from './reminders-list'
import { usePendingReminderCount } from '@/hooks/use-reminders'
import { useTabs } from '@/contexts/tabs'
import { cn } from '@/lib/utils'
import type { ReminderWithTarget } from '@/services/reminder-service'

// ============================================================================
// Types
// ============================================================================

interface RemindersPanelProps {
  /** Variant of the trigger button */
  variant?: 'default' | 'ghost' | 'outline'
  /** Size of the trigger button */
  size?: 'sm' | 'default' | 'lg' | 'icon'
  /** Class name for the trigger button */
  className?: string
  /** Side from which the sheet slides in */
  side?: 'top' | 'right' | 'bottom' | 'left'
}

// ============================================================================
// Component
// ============================================================================

export function RemindersPanel({
  variant = 'ghost',
  size = 'icon',
  className,
  side = 'right'
}: RemindersPanelProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const { count } = usePendingReminderCount()
  const { openTab } = useTabs()

  // Handle navigation to reminder target
  const handleNavigate = useCallback(
    (reminder: ReminderWithTarget) => {
      // Close the panel
      setOpen(false)

      // Navigate based on target type
      switch (reminder.targetType) {
        case 'note':
        case 'highlight':
          openTab({
            type: 'note',
            title: reminder.targetTitle || 'Note',
            icon: 'file-text',
            path: `/notes/${reminder.targetId}`,
            entityId: reminder.targetId,
            isPinned: false,
            isModified: false,
            isPreview: true,
            isDeleted: false
          })
          break

        case 'journal':
          openTab({
            type: 'journal',
            title: `Journal - ${reminder.targetId}`,
            icon: 'book-open',
            path: `/journal?date=${reminder.targetId}`,
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          })
          break
      }
    },
    [openTab]
  )

  const handleClose = useCallback(() => {
    setOpen(false)
  }, [])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button
              variant={variant}
              size={size}
              className={cn('relative', className)}
            >
              <Bell className="h-4 w-4" />
              <span className="sr-only">
                {count > 0 ? `${count} reminders` : 'Reminders'}
              </span>

              {/* Badge */}
              {count > 0 && (
                <span
                  className={cn(
                    'absolute -top-1 -right-1 flex items-center justify-center',
                    'min-w-[18px] h-[18px] px-1 rounded-full',
                    'bg-amber-500 text-white text-[10px] font-medium',
                    'animate-in fade-in zoom-in duration-200'
                  )}
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{count > 0 ? `${count} upcoming reminder${count !== 1 ? 's' : ''}` : 'Reminders'}</p>
        </TooltipContent>
      </Tooltip>

      <SheetContent side={side} className="w-[400px] sm:w-[450px] p-0">
        <SheetHeader className="sr-only">
          <SheetTitle>Reminders</SheetTitle>
        </SheetHeader>
        <RemindersList
          onNavigate={handleNavigate}
          onClose={handleClose}
          maxHeight="calc(100vh - 60px)"
          showHeader={true}
        />
      </SheetContent>
    </Sheet>
  )
}

// ============================================================================
// Bell Icon Button (Standalone)
// ============================================================================

interface RemindersBellButtonProps {
  /** Class name for the button */
  className?: string
  /** Button variant */
  variant?: 'default' | 'ghost' | 'outline'
  /** Button size */
  size?: 'sm' | 'default' | 'lg' | 'icon'
  /** Click handler */
  onClick?: () => void
}

/**
 * Standalone bell button with badge (for use in custom layouts)
 */
export function RemindersBellButton({
  className,
  variant = 'ghost',
  size = 'icon',
  onClick
}: RemindersBellButtonProps): React.ReactElement {
  const { count } = usePendingReminderCount()

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={variant}
          size={size}
          className={cn('relative', className)}
          onClick={onClick}
        >
          <Bell className="h-4 w-4" />
          <span className="sr-only">
            {count > 0 ? `${count} reminders` : 'Reminders'}
          </span>

          {/* Badge */}
          {count > 0 && (
            <span
              className={cn(
                'absolute -top-1 -right-1 flex items-center justify-center',
                'min-w-[18px] h-[18px] px-1 rounded-full',
                'bg-amber-500 text-white text-[10px] font-medium'
              )}
            >
              {count > 99 ? '99+' : count}
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{count > 0 ? `${count} upcoming reminder${count !== 1 ? 's' : ''}` : 'Reminders'}</p>
      </TooltipContent>
    </Tooltip>
  )
}
