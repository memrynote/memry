/**
 * Change Password Dialog Component
 *
 * Dialog for changing password (authenticated users).
 *
 * @module components/sync/change-password-dialog
 */

import { useState, useCallback } from 'react'
import { Lock, Eye, EyeOff, Loader2 } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import { PasswordStrength, validatePassword } from './password-strength'

// =============================================================================
// Types
// =============================================================================

interface ChangePasswordDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: { currentPassword: string; newPassword: string }) => Promise<void>
  isLoading?: boolean
  error?: string | null
}

// =============================================================================
// Component
// =============================================================================

/**
 * Change password dialog with current password verification.
 */
export function ChangePasswordDialog({
  open,
  onOpenChange,
  onSubmit,
  isLoading = false,
  error
}: ChangePasswordDialogProps) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  // Validation
  const currentPasswordValid = currentPassword.length > 0
  const newPasswordValidation = validatePassword(newPassword)
  const passwordsMatch = newPassword === confirmPassword
  const passwordsDifferent = currentPassword !== newPassword
  const isValid =
    currentPasswordValid && newPasswordValidation.isValid && passwordsMatch && passwordsDifferent

  // Reset form when dialog closes
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setCurrentPassword('')
        setNewPassword('')
        setConfirmPassword('')
        setShowCurrentPassword(false)
        setShowNewPassword(false)
        setShowConfirmPassword(false)
        setLocalError(null)
      }
      onOpenChange(open)
    },
    [onOpenChange]
  )

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setLocalError(null)

      if (!currentPasswordValid) {
        setLocalError('Please enter your current password')
        return
      }

      if (!newPasswordValidation.isValid) {
        setLocalError('New password does not meet requirements')
        return
      }

      if (!passwordsMatch) {
        setLocalError('New passwords do not match')
        return
      }

      if (!passwordsDifferent) {
        setLocalError('New password must be different from current password')
        return
      }

      try {
        await onSubmit({ currentPassword, newPassword })
        handleOpenChange(false)
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : 'An error occurred')
      }
    },
    [
      currentPassword,
      newPassword,
      currentPasswordValid,
      newPasswordValidation.isValid,
      passwordsMatch,
      passwordsDifferent,
      onSubmit,
      handleOpenChange
    ]
  )

  const displayError = error || localError

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change Password</DialogTitle>
          <DialogDescription>
            Enter your current password and choose a new password.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Current Password */}
          <div className="space-y-2">
            <Label htmlFor="current-password">Current Password</Label>
            <div className="relative">
              <Lock
                className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="current-password"
                type={showCurrentPassword ? 'text' : 'password'}
                placeholder="Enter current password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="pl-10 pr-10"
                disabled={isLoading}
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showCurrentPassword ? 'Hide password' : 'Show password'}
              >
                {showCurrentPassword ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          {/* New Password */}
          <div className="space-y-2">
            <Label htmlFor="new-password">New Password</Label>
            <div className="relative">
              <Lock
                className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="new-password"
                type={showNewPassword ? 'text' : 'password'}
                placeholder="Create a new password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="pl-10 pr-10"
                disabled={isLoading}
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowNewPassword(!showNewPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showNewPassword ? 'Hide password' : 'Show password'}
              >
                {showNewPassword ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
            <PasswordStrength password={newPassword} />
          </div>

          {/* Confirm New Password */}
          <div className="space-y-2">
            <Label htmlFor="confirm-new-password">Confirm New Password</Label>
            <div className="relative">
              <Lock
                className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="confirm-new-password"
                type={showConfirmPassword ? 'text' : 'password'}
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={cn(
                  'pl-10 pr-10',
                  confirmPassword && !passwordsMatch && 'border-red-500 focus-visible:ring-red-500'
                )}
                disabled={isLoading}
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
              >
                {showConfirmPassword ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
            {confirmPassword && !passwordsMatch && (
              <p className="text-sm text-red-500">Passwords do not match</p>
            )}
            {currentPassword && newPassword && !passwordsDifferent && (
              <p className="text-sm text-red-500">
                New password must be different from current password
              </p>
            )}
          </div>

          {/* Error Message */}
          {displayError && (
            <div
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3"
              role="alert"
            >
              <p className="text-sm text-destructive">{displayError}</p>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!isValid || isLoading}>
              {isLoading && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
              Change Password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
