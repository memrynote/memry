import { Link } from 'react-router'
import { ArrowRight, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { downloadHref, osLabel, platformForOS, useDetectedOS } from '@/lib/download'
import { trackLandingEvent } from '@/lib/analytics'

/**
 * Primary CTA pill — label + a filled circle that carries the arrow, sitting on a
 * white halo ring. Geometry mirrors the Paper slogan artboard (58px tall, 18px
 * radius, 6px trailing inset so the circle nests inside the pill). Shared by the
 * hero and the closing CTA so both asks look like the same button.
 */
export function DownloadPill({ location }: { location: string }) {
  const os = useDetectedOS()
  const platform = platformForOS(os)
  const label = platform ? `Download for ${osLabel(os)}` : 'Download'
  const track = () =>
    trackLandingEvent('landing_download_click', `download:${platform ?? 'all'}:${location}`)

  const className =
    'group/pill inline-flex min-h-[58px] items-center justify-center gap-[22px] rounded-[18px] border-2 border-white/85 bg-terracotta py-[5px] ps-[21px] pe-1.5 shadow-[0_0_0_5px_rgb(255_255_255/0.58)] transition-colors duration-200 hover:bg-terracotta-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/50'

  const content = (
    <>
      <span className="text-[14px] font-semibold leading-[18px] text-white">{label}</span>
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white text-terracotta transition-transform duration-200 motion-safe:group-hover/pill:translate-x-0.5">
        <ArrowRight className="h-[18px] w-[18px]" strokeWidth={2.2} aria-hidden />
      </span>
    </>
  )

  return platform ? (
    <a href={downloadHref(platform)} onClick={track} className={className}>
      {content}
    </a>
  ) : (
    <Link to="/download/desktop" onClick={track} className={className}>
      {content}
    </Link>
  )
}

export function DownloadButton({
  location,
  size = 'lg',
  className
}: {
  location: string
  size?: 'default' | 'sm' | 'lg'
  className?: string
}) {
  const os = useDetectedOS()
  const platform = platformForOS(os)
  const label = platform ? `Download for ${osLabel(os)}` : 'Download'
  const track = () =>
    trackLandingEvent('landing_download_click', `download:${platform ?? 'all'}:${location}`)

  return (
    <Button size={size} className={cn('rounded-full px-8', className)} asChild>
      {platform ? (
        <a href={downloadHref(platform)} onClick={track}>
          <Download className="h-4 w-4" />
          {label}
        </a>
      ) : (
        <Link to="/download/desktop" onClick={track}>
          <Download className="h-4 w-4" />
          {label}
        </Link>
      )}
    </Button>
  )
}

export function DownloadCTA({
  location,
  tone = 'default',
  className
}: {
  location: string
  tone?: 'default' | 'inverted'
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 sm:flex-row', className)}>
      <DownloadButton location={location} />
      <Button
        size="lg"
        variant="ghost"
        className={cn(
          'rounded-full px-6',
          tone === 'inverted'
            ? 'text-ink-inverted hover:bg-white/10'
            : 'text-ink hover:bg-paper-alt'
        )}
        asChild
      >
        <Link
          to="/download/desktop"
          onClick={() =>
            trackLandingEvent('landing_nav_click', `download:all-platforms:${location}`)
          }
        >
          All platforms
          <ArrowRight className="h-4 w-4" />
        </Link>
      </Button>
    </div>
  )
}
