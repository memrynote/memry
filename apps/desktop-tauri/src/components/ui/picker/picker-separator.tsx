import { cn } from '@/lib/utils'

interface PickerSeparatorProps {
  className?: string
}

export function PickerSeparator({ className }: PickerSeparatorProps): React.JSX.Element {
  return <div data-slot="picker-separator" className={cn('-mx-1 my-1 h-px bg-border', className)} />
}
