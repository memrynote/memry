import { cn } from '@/lib/utils'

interface FeatureHeroScreenshotProps {
  src: string
  alt: string
  width: number
  height: number
  className?: string
}

export function FeatureHeroScreenshot({
  src,
  alt,
  width,
  height,
  className
}: FeatureHeroScreenshotProps) {
  return (
    <div className={cn('relative mx-auto max-w-5xl', className)}>
      <div
        aria-hidden
        className="absolute -inset-x-12 -bottom-10 -top-6 -z-10 rounded-[40px] bg-[radial-gradient(ellipse_at_center,rgba(255,103,26,0.10),transparent_70%)]"
      />
      <div className="overflow-hidden rounded-[26px] border border-border/60 bg-ink shadow-[0_30px_80px_-30px_rgba(31,41,55,0.35)]">
        <img
          src={src}
          alt={alt}
          width={width}
          height={height}
          loading="eager"
          decoding="async"
          className="block h-auto w-full"
        />
      </div>
    </div>
  )
}
