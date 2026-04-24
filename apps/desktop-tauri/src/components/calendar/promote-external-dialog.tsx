import { useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'

export interface PromoteExternalDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (dontAskAgain: boolean) => void | Promise<void>
  isWorking?: boolean
  errorMessage?: string | null
}

export function PromoteExternalDialog({
  open,
  onOpenChange,
  onConfirm,
  isWorking = false,
  errorMessage = null
}: PromoteExternalDialogProps): React.JSX.Element | null {
  const [dontAskAgain, setDontAskAgain] = useState(false)

  if (!open) return null

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <DialogPrimitive.Content
          data-testid="promote-external-dialog"
          aria-label="Edit external calendar event"
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2',
            'rounded-md border bg-popover p-6 text-popover-foreground shadow-lg outline-none'
          )}
        >
          <DialogPrimitive.Title className="mb-1 text-lg font-semibold">
            Edit this event in Memry?
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mb-4 text-sm text-muted-foreground">
            Editing this event will create a linked copy in Memry so changes sync both ways.
            Continue?
          </DialogPrimitive.Description>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={dontAskAgain}
              onCheckedChange={(value) => setDontAskAgain(value === true)}
              disabled={isWorking}
              aria-label="Don't ask again"
            />
            <span className="text-muted-foreground">Don&apos;t ask again</span>
          </label>

          {errorMessage && (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {errorMessage}
            </p>
          )}

          <div className="mt-6 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={isWorking}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void onConfirm(dontAskAgain)}
              disabled={isWorking}
            >
              {isWorking ? 'Preparing…' : 'Edit in Memry'}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
