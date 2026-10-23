/**
 * Optional Notes-password field for the Apple Notes import.
 *
 * Locked notes are encrypted; the importer can read them only with the Notes
 * password. The password is checked against the locked notes' keys before the
 * run starts (`import:apple-notes:check-unlock`) so a typo shows up here
 * instead of as a summary full of skipped notes. It is held in this component's
 * state, reported upward only once it unlocks something, and never persisted.
 */

import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { AppleNotesCheckUnlockResult } from '@memry/contracts/import-channels'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { extractErrorMessage, unwrapIpcResult } from '@/lib/ipc-error'

interface AppleNotesPasswordFieldProps {
  sourcePath: string
  lockedNoteCount: number
  disabled: boolean
  /** The password once it unlocks at least one note; null whenever it does not. */
  onPasswordChange: (password: string | null) => void
}

export function AppleNotesPasswordField({
  sourcePath,
  lockedNoteCount,
  disabled,
  onPasswordChange
}: AppleNotesPasswordFieldProps) {
  const { t } = useT('settings')
  const [password, setPassword] = useState('')
  const [isChecking, setIsChecking] = useState(false)
  const [result, setResult] = useState<AppleNotesCheckUnlockResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const edit = (value: string): void => {
    setPassword(value)
    setResult(null)
    setError(null)
    onPasswordChange(null)
  }

  const check = async (): Promise<void> => {
    if (!password || isChecking) return
    setIsChecking(true)
    setError(null)
    try {
      const raw = await window.api.import.appleNotes.checkUnlock({ sourcePath, password })
      const verified = unwrapIpcResult(raw, t('import.dialog.appleNotes.password.checkError'))
      setResult(verified)
      onPasswordChange(verified.unlocked > 0 ? password : null)
    } catch (err) {
      setError(extractErrorMessage(err, t('import.dialog.appleNotes.password.checkError')))
    } finally {
      setIsChecking(false)
    }
  }

  const status = (): { text: string; tone: 'ok' | 'bad' } | null => {
    if (error) return { text: error, tone: 'bad' }
    if (!result) return null
    if (result.unlocked === 0) {
      return { text: t('import.dialog.appleNotes.password.wrong'), tone: 'bad' }
    }
    return {
      text:
        result.unlocked === result.total
          ? t('import.dialog.appleNotes.password.unlockedAll', { count: result.total })
          : t('import.dialog.appleNotes.password.unlockedSome', {
              unlocked: result.unlocked,
              total: result.total
            }),
      tone: 'ok'
    }
  }
  const shown = status()

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <p className="text-[13px]/4 font-medium text-foreground">
        {t('import.dialog.appleNotes.password.title', { count: lockedNoteCount })}
      </p>
      <p className="text-xs/4 text-muted-foreground">
        {t('import.dialog.appleNotes.password.hint')}
      </p>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void check()
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          value={password}
          disabled={disabled}
          placeholder={t('import.dialog.appleNotes.password.placeholder')}
          aria-label={t('import.dialog.appleNotes.password.label')}
          onChange={(event) => edit(event.target.value)}
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={disabled || !password || isChecking}
        >
          {isChecking ? <Spinner /> : t('import.dialog.appleNotes.password.check')}
        </Button>
      </form>
      {shown && (
        <p
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA role kept: the semantic tag (output/progress/fieldset/etc.) brings default styling/semantics that would change the layout
          role="status"
          className={
            shown.tone === 'bad' ? 'text-xs/4 text-destructive' : 'text-xs/4 text-muted-foreground'
          }
        >
          {shown.text}
        </p>
      )}
    </div>
  )
}
