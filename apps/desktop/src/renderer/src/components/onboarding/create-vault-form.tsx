import { useEffect, useId, useState } from 'react'
import type { SelectVaultResponse } from '@memry/contracts/vault-api'
import { Loader2 } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { vaultService } from '@/services/vault-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { FolderField } from './folder-field'
import { OnboardingStep } from './onboarding-step'

type Translate = (key: string) => string

// Mirrors isValidVaultFolderName in main/vault/create-vault.ts so the form can
// flag a bad name before the round trip; main stays the authority.
const INVALID_NAME = /[/\\:*?"<>|\0]/
const isInvalidName = (name: string): boolean => name.startsWith('.') || INVALID_NAME.test(name)

const joinPath = (parent: string, name: string): string => {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`
}

type FormError = { kind: 'exists' | 'invalid' | 'other'; message: string } | null

const KEY = 'phaseF.componentsVaultOnboarding.flow'

function toFormError(result: SelectVaultResponse, t: Translate): FormError {
  if (result.errorCode === 'already-exists') {
    return { kind: 'exists', message: t(`${KEY}.errorExists`) }
  }
  if (result.errorCode === 'invalid-name') {
    return { kind: 'invalid', message: t(`${KEY}.errorInvalidName`) }
  }
  return { kind: 'other', message: extractErrorMessage(result.error, t(`${KEY}.createFailed`)) }
}

/** Default parent folder, loaded once; the user may replace it with Change… */
function useParentFolder(): [string | null, (path: string) => void] {
  const [parent, setParent] = useState<string | null>(null)
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
  return [parent, setParent]
}

interface CreateVaultState {
  submitting: boolean
  error: FormError
  setError: (error: FormError) => void
  create: (parent: string, name: string) => Promise<void>
}

function useCreateVault(onCreated: () => void, t: Translate): CreateVaultState {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<FormError>(null)

  const create = async (parent: string, name: string): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      const result = await vaultService.create(parent, name)
      if (result.success) onCreated()
      else setError(toFormError(result, t))
    } catch (err) {
      setError({ kind: 'other', message: extractErrorMessage(err, t(`${KEY}.createFailed`)) })
    } finally {
      setSubmitting(false)
    }
  }

  return { submitting, error, setError, create }
}

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
  const [name, setName] = useState('')
  const [parent, setParent] = useParentFolder()
  const { submitting, error, setError, create } = useCreateVault(onCreated, t)

  const trimmed = name.trim()
  const nameInvalid = trimmed.length > 0 && isInvalidName(trimmed)
  const target = parent && trimmed ? joinPath(parent, trimmed) : null
  const canSubmit = !!target && !nameInvalid && !submitting
  const nameError = nameInvalid
    ? t(`${KEY}.errorInvalidName`)
    : error && error.kind !== 'other'
      ? error.message
      : null

  return (
    <form
      className="flex flex-col grow shrink basis-0 min-h-0"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit && parent) void create(parent, trimmed)
      }}
    >
      <OnboardingStep
        onBack={onBack}
        title={t(`${KEY}.createTitle`)}
        subtitle={t(`${KEY}.createSubtitle`)}
        footer={
          <>
            <Button type="button" variant="outline" size="sm" onClick={onBack}>
              {t(`${KEY}.cancel`)}
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {submitting && <Loader2 className="animate-spin" />}
              {submitting ? t(`${KEY}.creating`) : t(`${KEY}.createVault`)}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <NameField
            value={name}
            error={nameError}
            existingTarget={error?.kind === 'exists' ? target : null}
            onChange={(value) => {
              setName(value)
              if (error?.kind !== 'other') setError(null)
            }}
            onOpenExisting={onOpenExisting}
          />
          <FolderField
            label={t(`${KEY}.locationLabel`)}
            path={parent}
            onChange={(path) => {
              setParent(path)
              setError(null)
            }}
            onError={(message) => setError({ kind: 'other', message })}
          />
          {target && !nameError && <TargetPreview target={target} />}
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

function NameField({
  value,
  error,
  existingTarget,
  onChange,
  onOpenExisting
}: {
  value: string
  error: string | null
  /** Set when the name collides with a folder that can be opened instead */
  existingTarget: string | null
  onChange: (value: string) => void
  onOpenExisting: (path: string) => void
}): React.JSX.Element {
  const { t } = useT('common')
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs leading-4 font-medium text-text-secondary">
        {t(`${KEY}.nameLabel`)}
      </label>
      <Input
        id={id}
        autoFocus
        value={value}
        maxLength={100}
        placeholder={t(`${KEY}.namePlaceholder`)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cn(error && 'border-destructive focus-visible:ring-destructive')}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs leading-4 text-destructive">
          {error}{' '}
          {existingTarget && (
            <button
              type="button"
              onClick={() => onOpenExisting(existingTarget)}
              className="underline underline-offset-2 hover:text-foreground"
            >
              {t(`${KEY}.openInstead`)}
            </button>
          )}
        </p>
      )}
    </div>
  )
}

function TargetPreview({ target }: { target: string }): React.JSX.Element {
  const { t } = useT('common')
  return (
    <div className="flex flex-col gap-1 rounded-md bg-surface px-3 py-2.5">
      <span className="text-[11px] leading-[14px] text-text-tertiary">
        {t(`${KEY}.willBeCreatedAt`)}
      </span>
      <span className="font-mono text-xs leading-4 text-foreground break-all">{target}</span>
    </div>
  )
}
