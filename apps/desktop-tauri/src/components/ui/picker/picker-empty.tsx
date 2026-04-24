import { cn } from '@/lib/utils'

interface PickerEmptyProps {
  icon?: React.ReactNode
  message?: string
  action?: React.ReactNode
  className?: string
}

export function PickerEmpty({
  icon,
  message = 'No results',
  action,
  className
}: PickerEmptyProps): React.JSX.Element {
  return (
    <div
      data-slot="picker-empty"
      className={cn('flex flex-col items-center justify-center py-6 px-4 text-center', className)}
    >
      {icon && <span className="text-muted-foreground/50 mb-2">{icon}</span>}
      <p className="text-sm text-muted-foreground mb-3">{message}</p>
      {action}
    </div>
  )
}
