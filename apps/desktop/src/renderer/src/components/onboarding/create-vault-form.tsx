import { useEffect, useId, useState } from 'react'
import { Loader2 } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { vaultService } from '@/services/vault-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { OnboardingStep } from './onboarding-step'

// Mirrors isValidVaultFolderName in main/vault/create-vault.ts so the form can
// flag a bad name before the round trip; main stays the authority.
const INVALID_NAME = /[/\\:*?"<>|\0]/
const isInvalidName = (name: string): boolean => name.startsWith('.') || INVALID_NAME.test(name)

const joinPath = (parent: string, name: string): string => {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`
}

type FormError = { kind: 'exists' | 'invalid' | 'other'; message: string } | null

interface CreateVaultFormProps {
  onBack: () => void
  onCreated: () => void
  /** "Open it as a vault instead" when the target folder already exists */
  onOpenExisting: (path: string) => void
}

export function CreateVaultForm({
  onBack,
  onCreated,
  onOpenExisting
}: CreateVaultFormProps): React.JSX.Element {
  const { t } = useT('common')
  const nameId = useId()
  const [name, setName] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<FormError>(null)

  useEffect(() => {
    let cancelled = false
    vaultService
      .getDefaultParent()
      .then((path) => {
        if (!cancelled) setParent((current) => current ?? path)
      })
      .catch(() => {
        // No default: the user picks a location with Change… instead.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const trimmed = name.trim()
  const nameInvalid = trimmed.length > 0 && isInvalidName(trimmed)
  const target = parent && trimmed ? joinPath(parent, trimmed) : null
  const canSubmit = !!target && !nameInvalid && !submitting

  const chooseParent = async (): Promise<void> => {
    try {
      const { path } = await window.api.syncLinking.pickVaultFolder()
      if (path) {
        setParent(path)
        setError(null)
      }
    } catch (err) {
      setError({
        kind: 'other',
        message: extractErrorMessage(err, t('phaseF.componentsVaultOnboarding.flow.createFailed'))
      })
    }
  }

  const submit = async (): Promise<void> => {
    if (!canSubmit || !parent) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await vaultService.create(parent, trimmed)
      if (result.success) {
        onCreated()
        return
      }
      if (result.errorCode === 'already-exists') {
        setError({
          kind: 'exists',
          message: t('phaseF.componentsVaultOnboarding.flow.errorExists')
        })
      } else if (result.errorCode === 'invalid-name') {
        setError({
          kind: 'invalid',
          message: t('phaseF.componentsVaultOnboarding.flow.errorInvalidName')
        })
      } else {
        setError({
          kind: 'other',
          message: extractErrorMessage(
            result.error,
            t('phaseF.componentsVaultOnboarding.flow.createFailed')
          )
        })
      }
    } catch (err) {
      setError({
        kind: 'other',
        message: extractErrorMessage(err, t('phaseF.componentsVaultOnboarding.flow.createFailed'))
      })
    } finally {
      setSubmitting(false)
    }
  }

  const nameError = nameInvalid
    ? t('phaseF.componentsVaultOnboarding.flow.errorInvalidName')
    : error && error.kind !== 'other'
      ? error.message
      : null

  return (
    <form
      className="flex flex-col grow shrink basis-0 min-h-0"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <OnboardingStep
        onBack={onBack}
        title={t('phaseF.componentsVaultOnboarding.flow.createTitle')}
        subtitle={t('phaseF.componentsVaultOnboarding.flow.createSubtitle')}
        footer={
          <>
            <Button type="button" variant="outline" size="sm" onClick={onBack}>
              {t('phaseF.componentsVaultOnboarding.flow.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {submitting && <Loader2 className="animate-spin" />}
              {submitting
                ? t('phaseF.componentsVaultOnboarding.flow.creating')
                : t('phaseF.componentsVaultOnboarding.flow.createVault')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={nameId} className="text-xs leading-4 font-medium text-text-secondary">
              {t('phaseF.componentsVaultOnboarding.flow.nameLabel')}
            </label>
            <Input
              id={nameId}
              autoFocus
              value={name}
              maxLength={100}
              placeholder={t('phaseF.componentsVaultOnboarding.flow.namePlaceholder')}
              aria-invalid={!!nameError}
              aria-describedby={nameError ? `${nameId}-error` : undefined}
              onChange={(event) => {
                setName(event.target.value)
                if (error?.kind !== 'other') setError(null)
              }}
              className={cn(nameError && 'border-destructive focus-visible:ring-destructive')}
            />
            {nameError && (
              <p id={`${nameId}-error`} role="alert" className="text-xs leading-4 text-destructive">
                {nameError}{' '}
                {error?.kind === 'exists' && target && (
                  <button
                    type="button"
                    onClick={() => onOpenExisting(target)}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    {t('phaseF.componentsVaultOnboarding.flow.openInstead')}
                  </button>
                )}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs leading-4 font-medium text-text-secondary">
              {t('phaseF.componentsVaultOnboarding.flow.locationLabel')}
            </span>
            <div className="flex items-center h-9 gap-2 rounded-md border border-input ps-3 pe-1">
              <span className="grow shrink basis-0 min-w-0 truncate font-mono text-xs text-foreground">
                {parent ?? ''}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={() => void chooseParent()}
              >
                {t('phaseF.componentsVaultOnboarding.flow.change')}
              </Button>
            </div>
          </div>

          {target && !nameError && (
            <div className="flex flex-col gap-1 rounded-md bg-surface px-3 py-2.5">
              <span className="text-[11px] leading-[14px] text-text-tertiary">
                {t('phaseF.componentsVaultOnboarding.flow.willBeCreatedAt')}
              </span>
              <span className="font-mono text-xs leading-4 text-foreground break-all">
                {target}
              </span>
            </div>
          )}

          {error?.kind === 'other' && (
            <p role="alert" className="text-xs leading-4 text-destructive">
              {error.message}
            </p>
          )}
        </div>
      </OnboardingStep>
    </form>
  )
}
