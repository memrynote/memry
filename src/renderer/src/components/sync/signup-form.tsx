/**
 * Signup Form Component
 *
 * Email/password signup form with password strength indicator.
 *
 * @module components/sync/signup-form
 */

import { useState, useCallback } from 'react'
import { Mail, Lock, Eye, EyeOff, Loader2, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { PasswordStrength, validatePassword } from './password-strength'

// =============================================================================
// Types
// =============================================================================

interface SignupFormProps {
  onSubmit: (data: { email: string; password: string; deviceName: string }) => Promise<void>
  isLoading?: boolean
  error?: string | null
  className?: string
  defaultDeviceName?: string
}

// =============================================================================
// Component
// =============================================================================

/**
 * Email/password signup form with validation.
 */
export function SignupForm({
  onSubmit,
  isLoading = false,
  error,
  className,
  defaultDeviceName = ''
}: SignupFormProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [deviceName, setDeviceName] = useState(defaultDeviceName)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  // Validation
  const passwordValidation = validatePassword(password)
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  const passwordsMatch = password === confirmPassword
  const deviceNameValid = deviceName.trim().length > 0

  const isValid = emailValid && passwordValidation.isValid && passwordsMatch && deviceNameValid

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setLocalError(null)

      if (!emailValid) {
        setLocalError('Please enter a valid email address')
        return
      }

      if (!passwordValidation.isValid) {
        setLocalError('Password does not meet requirements')
        return
      }

      if (!passwordsMatch) {
        setLocalError('Passwords do not match')
        return
      }

      if (!deviceNameValid) {
        setLocalError('Please enter a device name')
        return
      }

      try {
        await onSubmit({
          email: email.trim(),
          password,
          deviceName: deviceName.trim()
        })
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : 'An error occurred')
      }
    },
    [
      email,
      password,
      deviceName,
      emailValid,
      passwordValidation.isValid,
      passwordsMatch,
      deviceNameValid,
      onSubmit
    ]
  )

  const displayError = error || localError

  return (
    <form onSubmit={handleSubmit} className={cn('space-y-4', className)}>
      {/* Email */}
      <div className="space-y-2">
        <Label htmlFor="signup-email">Email</Label>
        <div className="relative">
          <Mail
            className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="signup-email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="pl-10"
            disabled={isLoading}
            autoComplete="email"
            aria-describedby={displayError ? 'signup-error' : undefined}
          />
        </div>
      </div>

      {/* Password */}
      <div className="space-y-2">
        <Label htmlFor="signup-password">Password</Label>
        <div className="relative">
          <Lock
            className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="signup-password"
            type={showPassword ? 'text' : 'password'}
            placeholder="Create a strong password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="pl-10 pr-10"
            disabled={isLoading}
            autoComplete="new-password"
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
        <Label htmlFor="signup-confirm-password">Confirm Password</Label>
        <div className="relative">
          <Lock
            className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="signup-confirm-password"
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

      {/* Device Name */}
      <div className="space-y-2">
        <Label htmlFor="signup-device-name">Device Name</Label>
        <div className="relative">
          <Smartphone
            className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="signup-device-name"
            type="text"
            placeholder="My MacBook"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            className="pl-10"
            disabled={isLoading}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          A name to identify this device in your account
        </p>
      </div>

      {/* Error Message */}
      {displayError && (
        <div
          id="signup-error"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3"
          role="alert"
        >
          <p className="text-sm text-destructive">{displayError}</p>
        </div>
      )}

      {/* Submit Button */}
      <Button type="submit" className="w-full" disabled={!isValid || isLoading}>
        {isLoading && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
        Create Account
      </Button>
    </form>
  )
}
