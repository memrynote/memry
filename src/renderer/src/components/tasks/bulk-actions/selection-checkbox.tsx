import { useRef, useEffect } from "react"

import { cn } from "@/lib/utils"

// ============================================================================
// TYPES
// ============================================================================

interface SelectionCheckboxProps {
  /** Whether the checkbox is checked */
  checked: boolean
  /** Whether the checkbox is in indeterminate state (some selected) */
  indeterminate?: boolean
  /** Callback when checkbox state changes */
  onChange: (checked: boolean) => void
  /** Optional click handler (for stopping propagation) */
  onClick?: (e: React.MouseEvent) => void
  /** Whether the checkbox is disabled */
  disabled?: boolean
  /** Additional class names */
  className?: string
  /** Aria label for accessibility */
  "aria-label"?: string
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Checkbox component that supports the indeterminate state
 * Used for "select all" functionality where some items are selected
 */
export const SelectionCheckbox = ({
  checked,
  indeterminate = false,
  onChange,
  onClick,
  disabled = false,
  className,
  "aria-label": ariaLabel,
}: SelectionCheckboxProps): React.JSX.Element => {
  const checkboxRef = useRef<HTMLInputElement>(null)

  // Set indeterminate state imperatively (can't be done via attribute)
  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = indeterminate
    }
  }, [indeterminate])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    onChange(e.target.checked)
  }

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onClick?.(e)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // Prevent row click when pressing space/enter on checkbox
    if (e.key === " " || e.key === "Enter") {
      e.stopPropagation()
    }
  }

  return (
    <input
      ref={checkboxRef}
      type="checkbox"
      checked={checked}
      onChange={handleChange}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "size-4 shrink-0 cursor-pointer rounded border-gray-300",
        "text-primary focus:ring-primary focus:ring-offset-0",
        "transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // Custom styling for indeterminate state
        indeterminate && "indeterminate:bg-primary indeterminate:border-primary",
        className
      )}
    />
  )
}

export default SelectionCheckbox



