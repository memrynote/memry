import { useT } from '@memry/i18n/renderer'
import {
  READWISE_FOLDER_LAYOUTS,
  type ReadwiseFolderLayout,
  type ReadwiseOptions,
  type ReadwiseSetOptionsInput
} from '@memry/contracts/import-channels'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  COMPACT_SELECT,
  SEGMENTED,
  SEGMENT_ITEM,
  SETTINGS_CARD,
  SETTINGS_GROUP_LABEL,
  SettingRow
} from '@/components/settings/settings-primitives'
import { useNoteFoldersQuery } from '@/hooks/use-notes-query'

interface ReadwiseLocationSectionProps {
  options: ReadwiseOptions
  disabled: boolean
  onChange: (input: ReadwiseSetOptionsInput) => void
}

/** Root folder and folder layout (D3), shared by the first-import preview and the connected panel. */
export function ReadwiseLocationSection({
  options,
  disabled,
  onChange
}: ReadwiseLocationSectionProps) {
  const { t } = useT('settings')
  const { folders } = useNoteFoldersQuery()
  const folderPaths = folders.map((folder) => folder.path)
  const folderOptions = folderPaths.includes(options.rootFolder)
    ? folderPaths
    : [options.rootFolder, ...folderPaths]

  return (
    <section className="flex flex-col">
      <h4 className={SETTINGS_GROUP_LABEL}>{t('import.dialog.readwise.groups.location')}</h4>
      <div className={SETTINGS_CARD}>
        <SettingRow
          label={t('import.dialog.readwise.rootFolder.label')}
          description={t('import.dialog.readwise.rootFolder.description')}
        >
          <Select
            value={options.rootFolder}
            onValueChange={(rootFolder) => onChange({ rootFolder })}
            disabled={disabled}
          >
            <SelectTrigger
              aria-label={t('import.dialog.readwise.rootFolder.label')}
              className={`${COMPACT_SELECT} max-w-44 font-mono`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="max-h-60 overflow-y-auto">
              {folderOptions.map((path) => (
                <SelectItem key={path} value={path} className="font-mono text-xs/4">
                  /{path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label={t('import.dialog.readwise.layout.label')}
          description={t('import.dialog.readwise.layout.description')}
        >
          <ToggleGroup
            type="single"
            value={options.folderLayout}
            onValueChange={(value) => {
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the control only offers members of this union, so its string value is always one of them
              if (value) onChange({ folderLayout: value as ReadwiseFolderLayout })
            }}
            aria-label={t('import.dialog.readwise.layout.label')}
            className={SEGMENTED}
            disabled={disabled}
          >
            {READWISE_FOLDER_LAYOUTS.map((layout) => (
              <ToggleGroupItem key={layout} value={layout} className={SEGMENT_ITEM}>
                {t(`import.dialog.readwise.layout.options.${layout}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingRow>
      </div>
    </section>
  )
}
