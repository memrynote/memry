import { cn } from '@/lib/utils'

type StatusDotSize = 'xs' | 'sm' | 'md'

const sizeClasses: Record<StatusDotSize, string> = {
  xs: 'size-1.5',
  sm: 'size-2',
  md: 'size-3'
}

interface StatusDotProps extends React.ComponentProps<'span'> {
  color: string
  size?: StatusDotSize
}

export function StatusDot({
  color,
  size = 'sm',
  className,
  ...props
}: StatusDotProps): React.JSX.Element {
  return (
    <span
      className={cn('shrink-0 rounded-full', sizeClasses[size], className)}
      style={{ backgroundColor: color }}
      aria-hidden="true"
      {...props}
    />
  )
}
