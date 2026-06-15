import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { SettingsHeader } from '@/components/settings/settings-primitives'
import { Button } from '@/components/ui/button'
import { ImportDialog } from '@/components/settings/import-dialog'
import { IMPORT_CATALOG, type ImportCatalogItem } from '@/lib/import-catalog'

export function ImportSettings() {
  const { t } = useT('settings')
  const [active, setActive] = useState<ImportCatalogItem | null>(null)

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('import.header.title')} subtitle={t('import.header.subtitle')} />

      <p className="pb-6 text-xs/4 text-muted-foreground">{t('import.intro')}</p>

      <div className="flex flex-col rounded-lg overflow-clip border border-border bg-surface-active">
        {IMPORT_CATALOG.map((item, index) => {
          const Icon = item.icon
          return (
            <div key={item.id}>
              {index > 0 && <div className="h-px bg-border" />}
              <div className="flex items-center justify-between h-12 py-3 px-4">
                <div className="flex items-center gap-3 min-w-0">
                  <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="flex flex-col gap-px min-w-0">
                    <span className="font-medium text-[13px]/4 text-foreground">{item.name}</span>
                    <span className="text-xs/4 text-muted-foreground truncate">
                      {t(item.descriptionKey)}
                    </span>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="ms-4 shrink-0"
                  onClick={() => setActive(item)}
                >
                  {t('import.action')}
                </Button>
              </div>
            </div>
          )
        })}
      </div>

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
