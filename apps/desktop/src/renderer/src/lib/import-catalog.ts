import { Import } from '@/lib/icons'
import type { AppIcon } from '@/lib/icons/types'

export interface ImportCatalogItem {
  id: string
  name: string
  /** i18n key under `settings.import.sources.*` for the short description. */
  descriptionKey: string
  icon: AppIcon
  /** Native picker filter label + extensions. */
  fileLabel: string
  extensions: string[]
  allowMultiple: boolean
}

export const IMPORT_CATALOG: ImportCatalogItem[] = [
  {
    id: 'notion',
    name: 'Notion',
    descriptionKey: 'settings.import.sources.notion',
    icon: Import,
    fileLabel: 'Notion HTML export',
    extensions: ['zip'],
    allowMultiple: true
  }
]
