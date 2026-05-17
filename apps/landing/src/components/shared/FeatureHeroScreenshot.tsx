import { cn } from '@/lib/utils'
import { getFeatureScreenshotSrc, type FeatureScreenshotId } from '@/lib/feature-screenshots'
import { useTheme } from '@/lib/use-theme'

type FeatureHeroScreenshotProps = {
  alt: string
  width: number
  height: number
  className?: string
} & ({ src: string; screenshot?: never } | { screenshot: FeatureScreenshotId; src?: never })

export function FeatureHeroScreenshot({
  src,
  screenshot,
  alt,
  width,
  height,
  className
}: FeatureHeroScreenshotProps) {
  const { theme } = useTheme()
  const imageSrc = screenshot ? getFeatureScreenshotSrc(screenshot, theme) : src

  return (
    <div className={cn('relative mx-auto max-w-5xl', className)}>
      <div
        aria-hidden
        className="absolute -inset-x-12 -bottom-10 -top-6 -z-10 rounded-[40px] bg-[radial-gradient(ellipse_at_center,rgba(255,103,26,0.10),transparent_70%)]"
      />
      <div className="overflow-hidden rounded-[26px] border border-border/60 bg-ink shadow-[0_30px_80px_-30px_rgba(31,41,55,0.35)]">
        <img
          src={imageSrc}
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
