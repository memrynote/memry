/**
 * Password Strength Indicator
 *
 * Visual indicator showing password strength with individual checks.
 *
 * @module components/sync/password-strength
 */

import { useMemo } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { validatePassword, type PasswordValidationResult } from '@/services/auth-service'

// =============================================================================
// Types
// =============================================================================

interface PasswordStrengthProps {
  password: string
  className?: string
  showChecks?: boolean
}

// =============================================================================
// Constants
// =============================================================================

const STRENGTH_COLORS = {
  weak: 'bg-red-500',
  fair: 'bg-yellow-500',
  good: 'bg-blue-500',
  strong: 'bg-green-500'
} as const

const STRENGTH_LABELS = {
  weak: 'Weak',
  fair: 'Fair',
  good: 'Good',
  strong: 'Strong'
} as const

const STRENGTH_WIDTH = {
  weak: 'w-1/4',
  fair: 'w-2/4',
  good: 'w-3/4',
  strong: 'w-full'
} as const

// =============================================================================
// Check Item Component
// =============================================================================

interface CheckItemProps {
  label: string
  passed: boolean
}

function CheckItem({ label, passed }: CheckItemProps) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {passed ? (
        <Check className="size-4 text-green-500" aria-hidden="true" />
      ) : (
        <X className="size-4 text-muted-foreground" aria-hidden="true" />
      )}
      <span className={cn(passed ? 'text-foreground' : 'text-muted-foreground')}>{label}</span>
    </div>
  )
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * Password strength indicator with visual bar and optional checks.
 */
export function PasswordStrength({
  password,
  className,
  showChecks = true
}: PasswordStrengthProps) {
  const validation = useMemo<PasswordValidationResult>(() => {
    if (!password) {
      return {
        isValid: false,
        errors: [],
        strength: 'weak',
        checks: {
          minLength: false,
          hasUppercase: false,
          hasLowercase: false,
          hasNumber: false,
          hasSpecial: false
        }
      }
    }
    return validatePassword(password)
  }, [password])

  const { strength, checks } = validation

  // Don't show anything if password is empty
  if (!password) {
    return null
  }

  return (
    <div className={cn('space-y-3', className)}>
      {/* Strength Bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Password strength</span>
          <span
            className={cn(
              'text-sm font-medium',
              strength === 'weak' && 'text-red-500',
              strength === 'fair' && 'text-yellow-500',
              strength === 'good' && 'text-blue-500',
              strength === 'strong' && 'text-green-500'
            )}
          >
            {STRENGTH_LABELS[strength]}
          </span>
        </div>
        <div
          className="h-2 w-full rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={
            strength === 'weak' ? 25 : strength === 'fair' ? 50 : strength === 'good' ? 75 : 100
          }
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Password strength: ${STRENGTH_LABELS[strength]}`}
        >
          <div
            className={cn(
              'h-full rounded-full transition-all duration-300',
              STRENGTH_COLORS[strength],
              STRENGTH_WIDTH[strength]
            )}
          />
        </div>
      </div>

      {/* Individual Checks */}
      {showChecks && (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          <CheckItem label="At least 12 characters" passed={checks.minLength} />
          <CheckItem label="Uppercase letter" passed={checks.hasUppercase} />
          <CheckItem label="Lowercase letter" passed={checks.hasLowercase} />
          <CheckItem label="Number" passed={checks.hasNumber} />
          <CheckItem label="Special character" passed={checks.hasSpecial} />
        </div>
      )}
    </div>
  )
}

// =============================================================================
// Compact Version
// =============================================================================

interface PasswordStrengthCompactProps {
  password: string
  className?: string
}

/**
 * Compact password strength indicator (bar only).
 */
export function PasswordStrengthCompact({ password, className }: PasswordStrengthCompactProps) {
  return <PasswordStrength password={password} className={className} showChecks={false} />
}

// =============================================================================
// Export validation helper
// =============================================================================

export { validatePassword }
