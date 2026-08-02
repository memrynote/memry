import { Link } from 'react-router'
import { ArrowRight, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { downloadHref, osLabel, platformForOS, useDetectedOS } from '@/lib/download'
import { trackLandingEvent } from '@/lib/analytics'

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
