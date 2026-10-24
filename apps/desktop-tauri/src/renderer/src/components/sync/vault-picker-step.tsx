import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { extractErrorMessage } from '@/lib/ipc-error'
import { Loader2 } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import type { WizardVaultSummary } from '@/contexts/auth-context'

interface VaultPickerStepProps {
  sessionId: string
  vaults: WizardVaultSummary[]
  onError: (error: string) => void
}

const formatDate = (createdAt?: number | null): string =>
  createdAt ? new Date(createdAt * 1000).toLocaleDateString() : ''

/**
 * Multi-vault linking picker (shown when the linked account has 2+ vaults).
 * The user picks a parent folder and checks which server vault(s) to pull;
 * the first checked vault opens + syncs now, the rest are created dormant.
 * On success the `sync:linking-finalized` event (auth-context) advances the
 * wizard to authenticated — this component only kicks off the finalize.
 */
export function VaultPickerStep({
  sessionId,
  vaults,
  onError
}: VaultPickerStepProps): React.JSX.Element {
  const { t } = useT('settings')
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>(() =>
    vaults.length > 0 ? [vaults[0].vaultUuid] : []
  )
  const [submitting, setSubmitting] = useState(false)
  // The wizard only renders `wizardError` on the sign-in/OTP/recovery steps, so
  // this step keeps its own copy — otherwise a failed pull looks like a dead
  // button (the error reached onError and was never shown).
  const [error, setError] = useState<string | null>(null)

  const orderedSelection = vaults
    .map((vault) => vault.vaultUuid)
    .filter((vaultUuid) => selected.includes(vaultUuid))

  const toggle = useCallback((vaultUuid: string) => {
    setSelected((prev) =>
      prev.includes(vaultUuid) ? prev.filter((id) => id !== vaultUuid) : [...prev, vaultUuid]
    )
  }, [])

  const chooseFolder = useCallback(async () => {
    try {
      const { path } = await window.api.syncLinking.pickVaultFolder()
      if (path) setFolderPath(path)
    } catch (err) {
      onError(extractErrorMessage(err, t('setup.linking.deviceFailed')))
    }
  }, [onError, t])

  const confirm = useCallback(async () => {
    const ordered = vaults
      .map((vault) => vault.vaultUuid)
      .filter((vaultUuid) => selected.includes(vaultUuid))
    if (!folderPath || ordered.length === 0 || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await window.api.syncLinking.finalizeVaultChoice({
        sessionId,
        parentFolderPath: folderPath,
        selectedVaultUuids: ordered,
        primaryVaultUuid: ordered[0]
      })
      if (!result.success) {
        const message = result.error ?? t('setup.linking.deviceFailed')
        setSubmitting(false)
        setError(message)
        onError(message)
      }
    } catch (err) {
      const message = extractErrorMessage(err, t('setup.linking.deviceFailed'))
      setSubmitting(false)
      setError(message)
      onError(message)
    }
  }, [folderPath, selected, vaults, submitting, sessionId, onError, t])

  if (submitting) {
    return (
      <output
        className="wizard-step-enter flex flex-col items-center justify-center py-12 gap-4"
        aria-live="polite"
      >
        <Loader2 className="w-10 h-10 animate-spin text-[var(--tint)]" aria-hidden="true" />
        <p className="font-serif text-[15px] text-muted-foreground">
          {t('setup.linking.pendingSuccess')}
        </p>
      </output>
    )
  }

  return (
    <div className="wizard-step-enter flex flex-col gap-5 py-4">
      <div className="space-y-1 text-center">
        <p className="font-display text-lg tracking-tight">{t('setup.linking.vaultPickerTitle')}</p>
        <p className="font-serif text-[15px] text-muted-foreground leading-relaxed">
          {t('setup.linking.vaultPickerDescription')}
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('setup.linking.vaultPickerFolderLabel')}
        </p>
        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={() => void chooseFolder()}
        >
          <span className="truncate text-start">
            {folderPath ?? t('setup.linking.vaultPickerChooseFolder')}
          </span>
        </Button>
      </div>

      <ul className="space-y-2">
        {vaults.map((vault) => {
          const isChecked = selected.includes(vault.vaultUuid)
          const isPrimary = orderedSelection[0] === vault.vaultUuid
          return (
            <li key={vault.vaultUuid}>
              <label className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5 cursor-pointer hover:bg-muted/50">
                <Checkbox
                  checked={isChecked}
                  onCheckedChange={() => toggle(vault.vaultUuid)}
                  aria-label={vault.vaultUuid}
                />
                <span className="flex-1 text-start text-sm">
                  {t('setup.linking.vaultRow', {
                    count: vault.itemCount ?? 0,
                    date: formatDate(vault.createdAt)
                  })}
                </span>
                {isChecked && (
                  <span className="text-xs text-muted-foreground">
                    {isPrimary
                      ? t('setup.linking.vaultPickerPrimaryHint')
                      : t('setup.linking.vaultPickerDormantHint')}
                  </span>
                )}
              </label>
            </li>
          )
        })}
      </ul>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <Button
        className="w-full"
        disabled={!folderPath || orderedSelection.length === 0}
        onClick={() => void confirm()}
      >
        {t('setup.linking.vaultPickerConfirm')}
      </Button>
    </div>
  )
}
