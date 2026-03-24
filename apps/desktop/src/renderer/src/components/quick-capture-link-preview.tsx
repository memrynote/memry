import { Check } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface LinkPreviewCardProps {
  title: string
  domain: string
  favicon?: string
  loading?: boolean
}

export function LinkPreviewCard({
  title,
  domain,
  favicon,
  loading
}: LinkPreviewCardProps): React.JSX.Element {
  const initial = domain.charAt(0).toUpperCase()

  if (loading) {
    return (
      <div className="flex items-center gap-2.5 px-4 py-2.5 bg-foreground/[0.02] border-t border-border/30">
        <div className="size-7 rounded-md bg-foreground/[0.06] animate-pulse shrink-0" />
        <div className="flex flex-col gap-1.5 flex-1 min-w-0">
          <div className="h-3.5 w-40 rounded bg-foreground/[0.06] animate-pulse" />
          <div className="h-3 w-20 rounded bg-foreground/[0.04] animate-pulse" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 bg-foreground/[0.02] border-t border-border/30">
      {favicon ? (
        <img
          src={favicon}
          alt=""
          className="size-7 rounded-md object-cover shrink-0 bg-foreground/[0.06]"
          onError={(e) => {
            e.currentTarget.style.display = 'none'
            e.currentTarget.nextElementSibling?.classList.remove('hidden')
          }}
        />
      ) : null}
      <div
        className={cn(
          'flex items-center justify-center size-7 rounded-md shrink-0',
          'bg-gradient-to-br from-[oklch(0.567_0.014_-0.158)] to-[oklch(0.606_0.085_-0.202)]',
          favicon && 'hidden'
        )}
      >
        <span className="font-heading text-[13px] font-bold text-white">{initial}</span>
      </div>

      <div className="flex flex-col gap-px flex-1 min-w-0">
        <span className="text-[13px]/[18px] font-medium text-foreground truncate">{title}</span>
        <span className="text-[11px]/[16px] text-muted-foreground/60">{domain}</span>
      </div>

      <div className="flex items-center gap-1 rounded-full py-0.5 px-2 bg-accent-green/10 shrink-0">
        <Check className="size-2.5 text-accent-green" />
        <span className="text-[10px]/3 font-semibold tracking-wide text-accent-green">LINK</span>
      </div>
    </div>
  )
}
