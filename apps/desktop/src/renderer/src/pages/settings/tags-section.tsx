import { Separator } from '@/components/ui/separator'
import { TagManager } from '@/components/settings/tag-manager'

export function TagsSettings() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Tags</h3>
        <p className="text-sm text-muted-foreground">
          Manage tags across your notes, journals, and tasks
        </p>
      </div>

      <Separator />

      <TagManager />
    </div>
  )
}
