import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--color-terracotta)] text-white shadow-sm hover:bg-[var(--color-terracotta-dark)] active:scale-[0.98]',
        secondary:
          'bg-[var(--color-paper-alt)] text-[var(--color-ink)] border border-[var(--color-border)] shadow-sm hover:bg-[var(--color-border)]',
        ghost: 'text-[var(--color-ink)] hover:bg-[var(--color-paper-alt)]',
        link: 'text-[var(--color-terracotta)] underline-offset-4 hover:underline',
        outline:
          'border border-[var(--color-border)] bg-transparent text-[var(--color-ink)] hover:bg-[var(--color-paper-alt)]'
      },
      size: {
        default: 'h-10 px-5 py-2',
        sm: 'h-9 px-4 text-sm',
        lg: 'h-12 px-8 text-base',
        icon: 'h-10 w-10'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
