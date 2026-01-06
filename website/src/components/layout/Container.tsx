import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface ContainerProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'full'
}

export function Container({ children, size = 'lg', className, ...props }: ContainerProps) {
  return (
    <div
      className={cn(
        'mx-auto w-full px-6',
        {
          'max-w-3xl': size === 'sm',
          'max-w-5xl': size === 'md',
          'max-w-7xl': size === 'lg',
          'max-w-none': size === 'full'
        },
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}
