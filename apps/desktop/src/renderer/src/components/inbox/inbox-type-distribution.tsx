import type { LucideIcon } from 'lucide-react'
import {
  FileText,
  Link2,
  Mic,
  Image,
  StickyNote,
  Paperclip,
  MessageCircle,
  Bell,
  HelpCircle,
  File
} from 'lucide-react'
import type { InboxStats } from '../../../../preload/index.d'

export interface InboxTypeDistributionProps {
  stats: InboxStats | null
}

const TYPE_CONFIG: Record<string, { icon: LucideIcon; label: string }> = {
  text: { icon: FileText, label: 'Text' },
  note: { icon: StickyNote, label: 'Note' },
  link: { icon: Link2, label: 'Link' },
  voice: { icon: Mic, label: 'Voice' },
  image: { icon: Image, label: 'Image' },
  clip: { icon: Paperclip, label: 'Clip' },
  pdf: { icon: File, label: 'PDF' },
  social: { icon: MessageCircle, label: 'Social' },
  reminder: { icon: Bell, label: 'Reminder' }
}

const DEFAULT_CONFIG = {
  icon: HelpCircle,
  label: 'Other'
}

export function InboxTypeDistribution({ stats }: InboxTypeDistributionProps): React.JSX.Element {
  if (!stats?.itemsByType || Object.keys(stats.itemsByType).length === 0) {
    return (
      <div className="p-6 rounded-xl border border-border/50 bg-card h-full flex flex-col items-center justify-center min-h-[200px]">
        <span className="text-muted-foreground font-serif italic">No item types to display</span>
      </div>
    )
  }

  const sortedTypes = Object.entries(stats.itemsByType)
    .sort(([, a], [, b]) => b - a)
    .filter(([, count]) => count > 0)

  const maxCount = sortedTypes.length > 0 ? sortedTypes[0][1] : 0

  return (
    <div className="p-6 rounded-xl border border-border/50 bg-card flex flex-col h-full">
      <div className="mb-6">
        <h3 className="text-lg font-serif font-medium text-foreground">Item Types</h3>
        <p className="text-sm text-muted-foreground mt-1">Distribution of content formats</p>
      </div>

      <div className="space-y-4">
        {sortedTypes.map(([type, count]) => {
          const config = TYPE_CONFIG[type] || { ...DEFAULT_CONFIG, label: type }
          const Icon = config.icon
          const percentage = maxCount > 0 ? (count / maxCount) * 100 : 0

          return (
            <div key={type} className="group">
              <div className="flex items-center justify-between mb-1.5 text-sm">
                <div className="flex items-center gap-2">
                  <Icon className="size-4 text-muted-foreground" />
                  <span className="font-medium text-foreground capitalize">{config.label}</span>
                </div>
                <span className="text-muted-foreground font-display tabular-nums">{count}</span>
              </div>

              <div className="h-2 w-full bg-muted/50 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500 ease-out bg-primary/60"
                  style={{ width: `${percentage}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
