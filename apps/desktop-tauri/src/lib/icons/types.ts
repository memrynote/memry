import type { ComponentPropsWithRef, ForwardRefExoticComponent } from 'react'

export type AppIcon = ForwardRefExoticComponent<
  ComponentPropsWithRef<'svg'> & {
    size?: string | number
    strokeWidth?: number
    absoluteStrokeWidth?: boolean
  }
>
