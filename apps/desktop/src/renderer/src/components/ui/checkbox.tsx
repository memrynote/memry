import * as React from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check } from '@/lib/icons'

import { cn } from '@/lib/utils'

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'grid place-content-center peer h-4 w-4 shrink-0 rounded-sm border border-primary shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[var(--tint)] data-[state=checked]:bg-[var(--tint)] data-[state=checked]:text-[var(--tint-foreground)]',
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn('grid place-content-center text-current animate-in zoom-in-50 duration-100')}
    >
      <Check className="h-4 w-4" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
