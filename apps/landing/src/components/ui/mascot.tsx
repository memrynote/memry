import { cn } from '@/lib/utils'

interface MascotProps {
  /** Light-theme path under /mascots; the dark variant lives at /mascots/dark. */
  src: string
  className?: string
  alt?: string
}

/**
 * Hand-drawn mascot image that follows the theme: ink-on-paper PNG in light
 * mode, the recolored /mascots/dark variant when `.dark` is active.
 */
export function Mascot({ src, className, alt = '' }: MascotProps) {
  const darkSrc = src.replace('/mascots/', '/mascots/dark/')

  return (
    <>
      <img
        src={src}
        alt={alt}
        className={cn('object-contain dark:hidden', className)}
        loading="lazy"
      />
      <img
        src={darkSrc}
        alt={alt}
        className={cn('hidden object-contain dark:block', className)}
        loading="lazy"
      />
    </>
  )
}
