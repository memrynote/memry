import { cn } from '@/lib/utils'

interface MascotProps {
  /** Path under /mascots. */
  src: string
  className?: string
  alt?: string
}

/** Hand-drawn ink-on-paper mascot image. */
export function Mascot({ src, className, alt = '' }: MascotProps) {
  return <img src={src} alt={alt} className={cn('object-contain', className)} loading="lazy" />
}
