import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface MockupFrameProps {
  children?: ReactNode
  imageSrc?: string
  imageAlt?: string
  className?: string
}

export function MockupFrame({
  children,
  imageSrc,
  imageAlt = 'App screenshot',
  className
}: MockupFrameProps) {
  return (
    <div
      className={cn(
        'relative rounded-xl overflow-hidden bg-surface-elevated shadow-xl border border-border',
        className
      )}
    >
      <div className="flex items-center gap-2 px-4 py-3 bg-surface border-b border-border">
        <div className="flex gap-2">
          <div className="w-3 h-3 rounded-full bg-[#FF5F57]" />
          <div className="w-3 h-3 rounded-full bg-[#FFBD2E]" />
          <div className="w-3 h-3 rounded-full bg-[#28CA41]" />
        </div>
        <div className="flex-1 flex justify-center">
          <div className="px-4 py-1 rounded-md bg-background text-xs text-muted">Memry</div>
        </div>
        <div className="w-[52px]" />
      </div>

      <div className="relative aspect-[16/10] bg-background">
        {imageSrc ? (
          <img src={imageSrc} alt={imageAlt} className="w-full h-full object-cover object-top" />
        ) : children ? (
          children
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center p-8">
              <div className="w-16 h-16 mx-auto mb-4 rounded-xl bg-surface flex items-center justify-center">
                <span className="text-2xl">📸</span>
              </div>
              <p className="text-sm text-muted">Screenshot placeholder</p>
              <p className="text-xs text-muted/60 mt-1">Replace with actual app screenshot</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
