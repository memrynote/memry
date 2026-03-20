import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const filterOptionRowVariants = cva('flex items-center transition-colors focus:outline-none', {
  variants: {
    variant: {
      default: 'rounded-[5px] py-1.5 px-2 gap-2 hover:bg-accent',
      compact: 'py-[9px] px-4 gap-2.5 hover:bg-accent'
    }
  },
  defaultVariants: {
    variant: 'default'
  }
})

interface FilterOptionRowProps
  extends React.ComponentProps<'button'>, VariantProps<typeof filterOptionRowVariants> {
  icon?: React.ReactNode
  label: string
  trailing?: React.ReactNode
  selected?: boolean
}

export function FilterOptionRow({
  icon,
  label,
  trailing,
  selected = false,
  variant,
  className,
  ...props
}: FilterOptionRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(filterOptionRowVariants({ variant }), selected && 'bg-accent', className)}
      {...props}
    >
      {icon}
      <span
        className={cn(
          'text-[13px] leading-4',
          selected ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {label}
      </span>
      {trailing}
    </button>
  )
}
