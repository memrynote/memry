import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const pillVariants = cva('inline-flex items-center shrink-0 rounded-[10px] gap-1', {
  variants: {
    variant: {
      bordered: 'border border-solid py-px px-[7px]',
      filled: 'py-px px-[7px]'
    },
    size: {
      default: 'text-[11px] leading-[14px]',
      sm: 'text-[10px] leading-[14px] font-medium'
    }
  },
  defaultVariants: {
    variant: 'bordered',
    size: 'default'
  }
})

type PillColor = 'amber' | 'emerald' | 'red' | 'indigo' | 'purple' | 'sky' | 'gray' | 'destructive'

const PILL_COLORS: Record<PillColor, { bordered: string; filled: string }> = {
  amber: {
    bordered: 'border-amber-500/30 text-amber-500 dark:border-amber-400/30 dark:text-amber-400',
    filled: 'bg-amber-500/10 text-amber-500 dark:bg-amber-400/10 dark:text-amber-400'
  },
  emerald: {
    bordered:
      'border-emerald-500/30 text-emerald-500 dark:border-emerald-400/30 dark:text-emerald-400',
    filled: 'bg-emerald-500/10 text-emerald-500 dark:bg-emerald-400/10 dark:text-emerald-400'
  },
  red: {
    bordered: 'border-red-500/30 text-red-500 dark:border-red-400/30 dark:text-red-400',
    filled: 'bg-red-500/10 text-red-500 dark:bg-red-400/10 dark:text-red-400'
  },
  indigo: {
    bordered: 'border-indigo-500/30 text-indigo-500 dark:border-indigo-400/30 dark:text-indigo-400',
    filled: 'bg-indigo-500/10 text-indigo-500 dark:bg-indigo-400/10 dark:text-indigo-400'
  },
  purple: {
    bordered: 'border-purple-400/30 text-purple-400 dark:border-purple-300/30 dark:text-purple-300',
    filled: 'bg-purple-400/10 text-purple-400 dark:bg-purple-300/10 dark:text-purple-300'
  },
  sky: {
    bordered: 'border-sky-400/30 text-sky-400 dark:border-sky-300/30 dark:text-sky-300',
    filled: 'bg-sky-400/10 text-sky-400 dark:bg-sky-300/10 dark:text-sky-300'
  },
  gray: {
    bordered: 'border-muted-foreground/30 text-muted-foreground',
    filled: 'bg-muted-foreground/10 text-muted-foreground'
  },
  destructive: {
    bordered: 'border-destructive/30 text-destructive',
    filled: 'bg-destructive/10 text-destructive'
  }
}

interface PillProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof pillVariants> {
  color?: PillColor
}

function Pill({
  className,
  variant = 'bordered',
  size,
  color = 'gray',
  children,
  ...props
}: PillProps): React.JSX.Element {
  const colorClasses = PILL_COLORS[color]?.[variant ?? 'bordered'] ?? ''

  return (
    <span className={cn(pillVariants({ variant, size }), colorClasses, className)} {...props}>
      {children}
    </span>
  )
}

export { Pill, pillVariants, type PillProps, type PillColor }
