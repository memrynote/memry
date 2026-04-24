import { Check, X } from '@/lib/icons'

export type PreviewVariant = 'image' | 'pdf' | 'social'

const VARIANT_CONFIG: Record<
  PreviewVariant,
  {
    gradient: string
    defaultInitial: string
    badge: string
    badgeBg: string
    badgeText: string
  }
> = {
  image: {
    gradient: 'from-[oklch(0.541_0.096_-0.227)] to-[oklch(0.627_0.130_-0.193)]',
    defaultInitial: 'I',
    badge: 'IMAGE',
    badgeBg: 'bg-accent-purple/[0.08]',
    badgeText: 'text-accent-purple'
  },
  pdf: {
    gradient: 'from-[oklch(0.505_0.169_0.088)] to-[oklch(0.637_0.188_0.089)]',
    defaultInitial: 'P',
    badge: 'PDF',
    badgeBg: 'bg-destructive/[0.08]',
    badgeText: 'text-destructive'
  },
  social: {
    gradient: 'from-[oklch(0.164_0_0)] to-[oklch(0.269_0_0)]',
    defaultInitial: 'X',
    badge: 'SOCIAL',
    badgeBg: 'bg-accent-cyan/[0.08]',
    badgeText: 'text-accent-cyan'
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface FilePreviewCardProps {
  variant: PreviewVariant
  title: string
  subtitle: string
  onClear: () => void
  initial?: string
}

export function FilePreviewCard({
  variant,
  title,
  subtitle,
  onClear,
  initial
}: FilePreviewCardProps): React.JSX.Element {
  const config = VARIANT_CONFIG[variant]
  const displayInitial = initial ?? config.defaultInitial

  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 bg-foreground/[0.02] border-t border-border/30">
      <div
        className={`flex items-center justify-center size-7 rounded-md shrink-0 bg-gradient-to-br ${config.gradient}`}
      >
        <span className="font-heading text-[13px] font-bold text-white">{displayInitial}</span>
      </div>

      <div className="flex flex-col gap-px flex-1 min-w-0">
        <span className="text-[13px]/[18px] font-medium text-foreground truncate">{title}</span>
        <span className="text-[11px]/[16px] text-muted-foreground/60 truncate">{subtitle}</span>
      </div>

      <div
        className={`flex items-center gap-1 rounded-full py-0.5 px-2 shrink-0 ${config.badgeBg}`}
      >
        <Check className={`size-2.5 ${config.badgeText}`} />
        <span className={`text-[10px]/3 font-semibold tracking-wide ${config.badgeText}`}>
          {config.badge}
        </span>
      </div>

      <button
        onClick={onClear}
        className="shrink-0 rounded p-0.5 text-muted-foreground/30 hover:text-foreground/60 transition-colors"
        aria-label="Remove attachment"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

export { FilePreviewCard as ImagePreviewCard }
