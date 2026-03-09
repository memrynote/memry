import { Separator } from '@/components/ui/separator'
import { StorageUsageBar } from '@/components/settings/storage-usage-bar'

export function VaultSettings() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Vault</h3>
        <p className="text-sm text-muted-foreground">Vault configuration and storage settings</p>
      </div>
      <Separator />
      <StorageUsageBar />
    </div>
  )
}
