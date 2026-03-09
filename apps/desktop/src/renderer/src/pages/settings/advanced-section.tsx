import { Separator } from '@/components/ui/separator'
import { TagManager } from '@/components/settings/tag-manager'

export function AdvancedSettings() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Advanced</h3>
        <p className="text-sm text-muted-foreground">Tag management and developer tools</p>
      </div>

      <Separator />

      <div className="space-y-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Tag Management
        </h4>
        <TagManager />
      </div>
    </div>
  )
}
