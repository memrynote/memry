/**
 * Reset Password Form Component
 *
 * Form for setting a new password with a reset token.
 *
 * @module components/sync/reset-password-form
 */

import { useState, useCallback } from 'react'
import { Lock, Eye, EyeOff, Loader2, CheckCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { PasswordStrength, validatePassword } from './password-strength'

// =============================================================================
// Types
// =============================================================================

interface ResetPasswordFormProps {
  token: string
  onSubmit: (data: { token: string; newPassword: string }) => Promise<void>
  onSuccess?: () => void
  isLoading?: boolean
  error?: string | null
  className?: string
}

// =============================================================================
// Component
// =============================================================================

/**
 * Reset password form with password strength indicator.
 */
export function ResetPasswordForm({
  token,
  onSubmit,
  onSuccess,
  isLoading = false,
  error,
  className
}: ResetPasswordFormProps) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [isSuccess, setIsSuccess] = useState(false)

  // Validation
  const passwordValidation = validatePassword(password)
  const passwordsMatch = password === confirmPassword
  const isValid = passwordValidation.isValid && passwordsMatch

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setLocalError(null)

      if (!passwordValidation.isValid) {
        setLocalError('Password does not meet requirements')
        return
      }

      if (!passwordsMatch) {
        setLocalError('Passwords do not match')
        return
      }

      try {
        await onSubmit({ token, newPassword: password })
        setIsSuccess(true)
        onSuccess?.()
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : 'An error occurred')
      }
    },
    [token, password, passwordValidation.isValid, passwordsMatch, onSubmit, onSuccess]
  )

  const displayError = error || localError

  // Success state
  if (isSuccess) {
    return (
      <div className={cn('space-y-6 text-center', className)}>
        <div className="flex justify-center">
          <div className="rounded-full bg-green-100 p-3 dark:bg-green-900/30">
            <CheckCircle className="size-8 text-green-600 dark:text-green-400" aria-hidden="true" />
          </div>
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-semibold">Password reset successful</h3>
          <p className="text-sm text-muted-foreground">
            Your password has been reset. You can now sign in with your new password.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('space-y-6', className)}>
      {/* Header */}
      <div className="space-y-2 text-center">
        <h3 className="text-lg font-semibold">Reset your password</h3>
        <p className="text-sm text-muted-foreground">Enter a new password for your account.</p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Password */}
        <div className="space-y-2">
          <Label htmlFor="reset-password">New Password</Label>
          <div className="relative">
            <Lock
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="reset-password"
              type={showPassword ? 'text' : 'password'}
              placeholder="Create a strong password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pl-10 pr-10"
              disabled={isLoading}
              autoComplete="new-password"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? (
                <EyeOff className="size-4" aria-hidden="true" />
              ) : (
                <Eye className="size-4" aria-hidden="true" />
              )}
            </button>
          </div>
          <PasswordStrength password={password} />
        </div>

        {/* Confirm Password */}
        <div className="space-y-2">
          <Label htmlFor="reset-confirm-password">Confirm New Password</Label>
          <div className="relative">
            <Lock
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="reset-confirm-password"
              type={showConfirmPassword ? 'text' : 'password'}
              placeholder="Confirm your password"
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

        {/* Submit Button */}
        <Button type="submit" className="w-full" disabled={!isValid || isLoading}>
          {isLoading && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
          Reset Password
        </Button>
      </form>
    </div>
  )
}
