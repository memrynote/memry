import { cn } from '@/lib/utils'
import { getFeatureScreenshotSrc, type FeatureScreenshotId } from '@/lib/feature-screenshots'

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
  const imageSrc = screenshot ? getFeatureScreenshotSrc(screenshot) : src

  return (
    <div className={cn('relative mx-auto max-w-5xl', className)}>
      <img
        src={imageSrc}
        alt={alt}
        width={width}
        height={height}
        loading="eager"
        decoding="async"
        className="block h-auto w-full drop-shadow-[0_24px_60px_rgba(31,41,55,0.30)]"
      />
    </div>
  )
}
