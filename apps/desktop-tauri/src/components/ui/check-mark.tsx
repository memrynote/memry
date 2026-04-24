import { Check } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface CheckMarkProps {
  color?: string
  size?: number
  className?: string
}

export function CheckMark({
  color = 'currentColor',
  size = 12,
  className
}: CheckMarkProps): React.JSX.Element {
  return <Check size={size} className={cn('shrink-0', className)} style={{ color }} />
}
