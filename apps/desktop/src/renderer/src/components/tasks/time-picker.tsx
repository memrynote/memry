import { X } from '@/lib/icons'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// TYPES
// ============================================================================

interface TimePickerProps {
  value: string | null
  onChange: (value: string | null) => void
  className?: string
}

// ============================================================================
// TIME PICKER COMPONENT
// ============================================================================

/**
 * Native time input ("HH:MM", any minute). Replaces the old 30-minute-increment
 * dropdown so users can enter exact times like 12:22.
 */
export const TimePicker = ({ value, onChange, className }: TimePickerProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('tasks')

  return (
    <div className={cn('relative flex items-center gap-1', className)}>
      <Input
        type="time"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label={tPhaseF('phaseF.componentsTasksTimePicker.selectTime')}
        className="w-full"
      />

      {/* Clear button */}
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            onChange(null)
          }}
          aria-label={tPhaseF('phaseF.componentsTasksTimePicker.clearTime')}
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  )
}

export default TimePicker
