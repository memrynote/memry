import { TagManager } from '@/components/settings/tag-manager'
import { SettingsHeader } from '@/components/settings/settings-primitives'

export function TagsSettings() {
  return (
    <div className="flex flex-col antialiased text-xs/4">
      <SettingsHeader title="Tags" subtitle="Manage tags across notes, journals, and tasks" />
      <TagManager />
    </div>
  )
}
