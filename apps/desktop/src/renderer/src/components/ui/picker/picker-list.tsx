import { cn } from '@/lib/utils'

interface PickerListProps extends React.HTMLAttributes<HTMLDivElement> {}

export function PickerList({ className, children, ...props }: PickerListProps): React.JSX.Element {
  return (
    <div
      data-slot="picker-list"
      className={cn('flex flex-col p-1 min-h-0 overflow-y-auto', className)}
      role="listbox"
      {...props}
    >
      {children}
    </div>
  )
}
