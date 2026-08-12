import { type ReactNode, useState, useCallback, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface MockupFrameProps {
  children?: ReactNode
  imageSrc?: string
  imageAlt?: string
  className?: string
  caption?: ReactNode
}

export function MockupFrame({
  children,
  imageSrc,
  imageAlt = 'App screenshot',
  className,
  caption
}: MockupFrameProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const isClickable = !!imageSrc

  const openLightbox = useCallback(() => {
    if (!isClickable) return
    setLightboxOpen(true)
    document.body.style.overflow = 'hidden'
  }, [isClickable])

  const closeLightbox = useCallback(() => {
    setLightboxOpen(false)
    document.body.style.overflow = ''
  }, [])

  useEffect(() => {
    if (!lightboxOpen) return

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox()
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
      document.body.style.overflow = ''
    }
  }, [lightboxOpen, closeLightbox])

  return (
    <>
      <motion.div
        className={cn(
          'relative rounded-xl overflow-hidden bg-card shadow-card border border-border/60',
          isClickable && 'cursor-zoom-in',
          className
        )}
        whileHover={isClickable ? { y: -6, scale: 1.015 } : undefined}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        onClick={openLightbox}
        role={isClickable ? 'button' : undefined}
        tabIndex={isClickable ? 0 : undefined}
        onKeyDown={
          isClickable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') openLightbox()
              }
            : undefined
        }
        aria-label={isClickable ? `View ${imageAlt} full size` : undefined}
      >
        <div className="flex items-center gap-3 px-4 py-3 bg-paper-alt border-b border-border/50">
          <div className="flex gap-2 opacity-60 hover:opacity-100 transition-opacity">
            <div className="w-3 h-3 rounded-full bg-[#FF5F57] shadow-inner" />
            <div className="w-3 h-3 rounded-full bg-[#FFBD2E] shadow-inner" />
            <div className="w-3 h-3 rounded-full bg-[#28CA41] shadow-inner" />
          </div>
          {caption && (
            <div className="ms-auto text-xs text-muted/70 font-mono-accent truncate">{caption}</div>
          )}
        </div>

        <div className="relative bg-card group">
          {imageSrc ? (
            <img src={imageSrc} alt={imageAlt} className="w-full h-auto block" />
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

          {isClickable && (
            <div className="absolute inset-0 flex items-center justify-center bg-ink/0 group-hover:bg-ink/5 transition-colors pointer-events-none">
              <motion.div
                className="px-3 py-1.5 rounded-full bg-ink/70 text-white text-xs font-mono-accent tracking-wide backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity"
                initial={false}
              >
                Click to expand
              </motion.div>
            </div>
          )}
        </div>
      </motion.div>

      <AnimatePresence>
        {lightboxOpen && imageSrc && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8 cursor-zoom-out"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={closeLightbox}
          >
            <motion.div className="absolute inset-0 bg-ink/80 backdrop-blur-sm" />

            <motion.button
              className="absolute top-4 right-4 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
              onClick={closeLightbox}
              aria-label="Close lightbox"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ delay: 0.1 }}
            >
              <X className="w-5 h-5" />
            </motion.button>

            <motion.img
              src={imageSrc}
              alt={imageAlt}
              className="relative max-w-full max-h-full rounded-lg shadow-2xl object-contain"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
