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
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      className={cn('shrink-0', className)}
    >
      <path
        d="M3 6l2 2 4-4"
        stroke={color}
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
