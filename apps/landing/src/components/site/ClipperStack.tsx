import { cn } from '@/lib/utils'

export interface ClipperStackProps {
  /**
   * Drop the scrapbook tilt. The homepage tile wants the pair to read as a styled
   * vignette; the feature page wants the capture itself read, so it sits square.
   */
  flat?: boolean
  className?: string
}

/**
 * The web clipper story in one frame: the captured note sits framed behind, and the
 * clipper popup floats in front on the trailing corner — the source that made it.
 */
export function ClipperStack({ flat, className }: ClipperStackProps) {
  return (
    <div className={cn('relative aspect-[4/3] w-full', className)}>
      {/* The captured note — behind, framed, nudged just off-true */}
      <div
        className={cn(
          'absolute bottom-0 start-0 w-[80%] overflow-hidden rounded-xl border border-ink/10 shadow-card',
          !flat && '-rotate-1'
        )}
      >
        <img
          src="/screenshots/webclipper-front_white.webp"
          alt="The clipped article, open as a note in MemryNote"
          width={812}
          height={764}
          loading="lazy"
          decoding="async"
          className="block aspect-[812/764] w-full object-cover object-top"
        />
      </div>
      {/* The clipper popup — floating in front, casting over the note */}
      <div
        className={cn(
          'absolute end-0 top-0 w-[44%] overflow-hidden rounded-xl shadow-elevated ring-1 ring-ink/10',
          !flat && 'rotate-2'
        )}
      >
        <img
          src="/screenshots/web-clipper.webp"
          alt="The MemryNote web clipper capturing the article"
          width={400}
          height={602}
          loading="lazy"
          decoding="async"
          className="block w-full object-contain"
        />
      </div>
    </div>
  )
}
