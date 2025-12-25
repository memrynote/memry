/**
 * PrimaryActionButton Component
 *
 * A warm amber gradient button for primary actions.
 * Features hover lift effect and glow shadow.
 * Designed for dialog CTAs and important actions.
 */

import { forwardRef, type ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface PrimaryActionButtonProps extends Omit<ComponentProps<typeof Button>, 'variant'> {
  /** Button content */
  children: React.ReactNode
}

export const PrimaryActionButton = forwardRef<HTMLButtonElement, PrimaryActionButtonProps>(
  ({ children, className, ...props }, ref) => {
    return (
      <Button
        ref={ref}
        className={cn(
          'px-5 gap-2',
          'bg-gradient-to-r from-amber-600 to-orange-600',
          'hover:from-amber-500 hover:to-orange-500',
          'text-white font-medium',
          'shadow-md shadow-amber-600/20',
          'transition-all duration-200',
          'hover:shadow-lg hover:shadow-amber-600/30',
          'hover:-translate-y-0.5',
          'active:translate-y-0',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          'disabled:hover:translate-y-0 disabled:hover:shadow-md',
          className
        )}
        {...props}
      >
        {children}
      </Button>
    )
  }
)

PrimaryActionButton.displayName = 'PrimaryActionButton'

export default PrimaryActionButton
