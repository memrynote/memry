import { cn } from '@/lib/utils'

interface PickerFooterProps {
  className?: string
  children: React.ReactNode
}

export function PickerFooter({ className, children }: PickerFooterProps): React.JSX.Element {
  return (
    <div data-slot="picker-footer" className={cn('border-t border-border', className)}>
      {children}
    </div>
  )
}
