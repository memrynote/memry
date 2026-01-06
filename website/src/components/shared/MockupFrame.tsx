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
        'relative rounded-xl overflow-hidden bg-white shadow-card border border-border/60',
        className
      )}
    >
      <div className="flex items-center gap-2 px-4 py-3 bg-paper-alt border-b border-border/50">
        <div className="flex gap-2 opacity-60 hover:opacity-100 transition-opacity">
          <div className="w-3 h-3 rounded-full bg-[#FF5F57] shadow-inner" />
          <div className="w-3 h-3 rounded-full bg-[#FFBD2E] shadow-inner" />
          <div className="w-3 h-3 rounded-full bg-[#28CA41] shadow-inner" />
        </div>
      </div>

      <div className="relative aspect-[16/10] bg-white group">
        {imageSrc ? (
          <img src={imageSrc} alt={imageAlt} className="w-full h-full object-cover object-top" />
        ) : children ? (
          children
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center p-8">
              <div className="w-16 h-16 mx-auto mb-4 rounded-xl bg-paper flex items-center justify-center border border-border border-dashed">
                <span className="text-2xl opacity-50">📸</span>
              </div>
              <p className="text-sm text-muted font-mono-accent">Screenshot placeholder</p>
              <p className="text-xs text-muted/60 mt-1 font-mono-accent">
                Replace with actual app screenshot
              </p>
            </div>
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-tr from-white/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
      </div>
    </div>
  )
}
