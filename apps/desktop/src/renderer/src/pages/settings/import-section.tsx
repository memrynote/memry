import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useT } from '@memry/i18n/renderer'
import { SettingsHeader } from '@/components/settings/settings-primitives'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ImportDialog } from '@/components/settings/import-dialog'
import { useImporters, type ImporterItem } from '@/hooks/use-importers'

export function ImportSettings() {
  const { t } = useT('settings')
  const { importers } = useImporters()
  const [active, setActive] = useState<ImporterItem | null>(null)

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('import.header.title')} subtitle={t('import.header.subtitle')} />

      <p className="pb-6 text-xs/4 text-muted-foreground">{t('import.intro')}</p>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="mb-6 justify-between w-72">
            {t('import.select')}
            <ChevronDown className="ms-2 w-4 h-4 text-muted-foreground shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          {importers.map((item) => {
            const Icon = item.icon
            return (
              <DropdownMenuItem key={item.id} onSelect={() => setActive(item)}>
                <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
                {item.name}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <ImportDialog
        item={active}
        open={active !== null}
        onOpenChange={(open) => {
          if (!open) setActive(null)
        }}
      />
    </div>
  )
}
