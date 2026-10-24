import { Button } from '@/components/ui/button'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'

/**
 * Read-only folder path with a "Change…" button that opens the native folder
 * picker. Shared by the create-vault form (location) and the account vault
 * picker (download destination).
 */
export function FolderField({
  label,
  path,
  disabled,
  onChange,
  onError
}: {
  label: string
  path: string | null
  disabled?: boolean
  onChange: (path: string) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const { t } = useT('common')

  const choose = async (): Promise<void> => {
    try {
      const { path: picked } = await window.api.syncLinking.pickVaultFolder()
      if (picked) onChange(picked)
    } catch (err) {
      onError(extractErrorMessage(err, t('phaseF.componentsVaultOnboarding.flow.openFailed')))
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs leading-4 font-medium text-text-secondary">{label}</span>
      <div className="flex items-center h-9 gap-2 rounded-md border border-input ps-3 pe-1">
        <span className="grow shrink basis-0 min-w-0 truncate font-mono text-xs text-foreground">
          {path ?? ''}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          disabled={disabled}
          onClick={() => void choose()}
        >
          {t('phaseF.componentsVaultOnboarding.flow.change')}
        </Button>
      </div>
    </div>
  )
}
