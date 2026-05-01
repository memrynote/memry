import * as React from 'react'
import { useState } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useT } from '@memry/i18n/renderer'

export interface TagRenameDialogProps {
  tag: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (newName: string) => Promise<void>
}

export function TagRenameDialog({
  tag,
  open,
  onOpenChange,
  onSubmit
}: TagRenameDialogProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  const { t } = useT('common')
  const [value, setValue] = useState(tag)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset dialog state during render whenever the dialog (re)opens or the
  // backing tag changes — avoids the no-adjust-state-on-prop-change anti-pattern.
  const [openSnapshot, setOpenSnapshot] = useState(open)
  const [tagSnapshot, setTagSnapshot] = useState(tag)
  if (open && (open !== openSnapshot || tag !== tagSnapshot)) {
    setOpenSnapshot(open)
    setTagSnapshot(tag)
    setValue(tag)
    setError(null)
    setSubmitting(false)
  } else if (!open && openSnapshot) {
    setOpenSnapshot(open)
  }

  const close = (): void => {
    if (submitting) return
    onOpenChange(false)
  }

  const handleSave = async (): Promise<void> => {
    const next = value.trim()
    if (!next) {
      setError('Tag name cannot be empty')
      return
    }
    if (next === tag) {
      onOpenChange(false)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(next)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void handleSave()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? close() : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tPhaseF('phaseF.componentsSidebarTagRenameDialog.renameTag')}</DialogTitle>
          <DialogDescription>
            {tPhaseF('phaseF.componentsSidebarTagRenameDialog.rename')}
            <span className="font-mono">#{tag}</span>{' '}
            {tPhaseF('phaseF.componentsSidebarTagRenameDialog.acrossEveryNoteThatUsesIt')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="tag-rename-input">
            {tPhaseF('phaseF.componentsSidebarTagRenameDialog.newName')}
          </Label>
          <Input
            id="tag-rename-input"
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              if (error) setError(null)
            }}
            onKeyDown={handleKeyDown}
            disabled={submitting}
            autoFocus
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'tag-rename-error' : undefined}
          />
          {error && (
            <p id="tag-rename-error" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={submitting}>
            {tPhaseF('phaseF.componentsSidebarTagRenameDialog.cancel')}
          </Button>
          <Button onClick={() => void handleSave()} disabled={submitting}>
            {submitting ? t('state.saving') : t('button.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default TagRenameDialog
