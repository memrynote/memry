'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

interface TrafficLightsProps {
  className?: string
  compact?: boolean
}

export function TrafficLights({ className, compact = false }: TrafficLightsProps) {
  const [isHovered, setIsHovered] = React.useState(false)

  const handleClose = () => {
    window.api.windowClose()
  }

  const handleMinimize = () => {
    window.api.windowMinimize()
  }

  const handleMaximize = () => {
    window.api.windowMaximize()
  }

  const buttonSize = compact ? 'size-2.5' : 'size-3.5'
  const iconSize = compact ? 'size-2.5' : 'size-3.5'

  return (
    <div
      className={cn(
        'flex items-center transition-all duration-200',
        compact ? 'gap-1.5' : 'gap-2',
        className
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Close button - Red */}
      <button
        onClick={handleClose}
        className={cn(
          'group relative rounded-full bg-[#FF5F57] hover:bg-[#FF5F57] transition-colors focus:outline-none',
          buttonSize
        )}
        aria-label="Close window"
      >
        {isHovered && (
          <svg
            className={cn('absolute inset-0 text-[#4D0000]', iconSize)}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        )}
      </button>

      {/* Minimize button - Yellow */}
      <button
        onClick={handleMinimize}
        className={cn(
          'group relative rounded-full bg-[#FEBC2E] hover:bg-[#FEBC2E] transition-colors focus:outline-none',
          buttonSize
        )}
        aria-label="Minimize window"
      >
        {isHovered && (
          <svg
            className={cn('absolute inset-0 text-[#995700]', iconSize)}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M2 6h8" />
          </svg>
        )}
      </button>

      {/* Maximize button - Green */}
      <button
        onClick={handleMaximize}
        className={cn(
          'group relative rounded-full bg-[#28C840] hover:bg-[#28C840] transition-colors focus:outline-none',
          buttonSize
        )}
        aria-label="Maximize window"
      >
        {isHovered && (
          <svg
            className={cn('absolute inset-0 text-[#006500]', iconSize)}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M2 2l8 8M10 2l-8 8" strokeWidth="0" />
            <path d="M4 2.5L9.5 8M8 2.5L2.5 8" strokeWidth="0" />
            <polygon points="2,4 2,10 8,10" fill="currentColor" stroke="none" />
            <polygon points="4,2 10,2 10,8" fill="currentColor" stroke="none" />
          </svg>
        )}
      </button>
    </div>
  )
}
