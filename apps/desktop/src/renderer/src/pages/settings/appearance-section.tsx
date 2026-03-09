import { Separator } from '@/components/ui/separator'

export function AppearanceSettings() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Appearance</h3>
        <p className="text-sm text-muted-foreground">Customize the look and feel</p>
      </div>
      <Separator />
      <div className="text-muted-foreground text-sm">Appearance settings coming soon...</div>
    </div>
  )
}
