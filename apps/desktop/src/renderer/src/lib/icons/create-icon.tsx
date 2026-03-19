import { HugeiconsIcon } from '@hugeicons/react'
import type { IconSvgElement } from '@hugeicons/react'
import { forwardRef } from 'react'
import type { AppIcon } from './types'

export function createIcon(icon: IconSvgElement): AppIcon {
  const Wrapped = forwardRef<
    SVGSVGElement,
    React.ComponentPropsWithRef<'svg'> & {
      size?: string | number
      strokeWidth?: number
      absoluteStrokeWidth?: boolean
    }
  >(({ className, strokeWidth, size, ...rest }, ref) => (
    <HugeiconsIcon
      ref={ref}
      icon={icon}
      className={className}
      strokeWidth={strokeWidth}
      size={size}
      {...rest}
    />
  ))
  Wrapped.displayName = 'AppIcon'
  return Wrapped as AppIcon
}
