/**
 * Focus Trap Hook
 *
 * Traps keyboard focus within a container element when active.
 * Used for modals and dialogs to ensure keyboard-only users
 * can navigate without focus escaping.
 *
 * @module hooks/use-focus-trap
 */

import { useEffect, useRef, useCallback } from 'react'

/**
 * Focusable element selector
 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])'

interface UseFocusTrapOptions {
  /** Whether the focus trap is active */
  isActive: boolean
  /** Whether to auto-focus the first focusable element */
  autoFocus?: boolean
  /** Whether to restore focus when deactivated */
  restoreFocus?: boolean
}

/**
 * Hook that traps focus within a container element.
 *
 * @example
 * ```tsx
 * function Modal({ isOpen, onClose }) {
 *   const containerRef = useFocusTrap({ isActive: isOpen })
 *
 *   return (
 *     <Dialog open={isOpen}>
 *       <DialogContent ref={containerRef}>
 *         <button>First</button>
 *         <button>Second</button>
 *       </DialogContent>
 *     </Dialog>
 *   )
 * }
 * ```
 */
export function useFocusTrap({
  isActive,
  autoFocus = true,
  restoreFocus = true
}: UseFocusTrapOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // Get all focusable elements within the container
  const getFocusableElements = useCallback((): HTMLElement[] => {
    if (!containerRef.current) return []
    return Array.from(containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  }, [])

  useEffect(() => {
    if (!isActive) return

    // Store current focus for restoration
    if (restoreFocus) {
      previousFocusRef.current = document.activeElement as HTMLElement
    }

    // Auto-focus first focusable element
    if (autoFocus) {
      // Use requestAnimationFrame to ensure DOM is ready
      requestAnimationFrame(() => {
        const focusableElements = getFocusableElements()
        if (focusableElements.length > 0) {
          focusableElements[0].focus()
        }
      })
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return

      const focusableElements = getFocusableElements()
      if (focusableElements.length === 0) return

      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]
      const activeElement = document.activeElement

      // Shift+Tab from first element -> go to last
      if (e.shiftKey && activeElement === firstElement) {
        e.preventDefault()
        lastElement.focus()
      }
      // Tab from last element -> go to first
      else if (!e.shiftKey && activeElement === lastElement) {
        e.preventDefault()
        firstElement.focus()
      }
      // If focus is outside container, bring it back
      else if (
        !containerRef.current?.contains(activeElement) &&
        containerRef.current?.contains(e.target as Node)
      ) {
        e.preventDefault()
        firstElement.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)

      // Restore focus when deactivating
      if (restoreFocus && previousFocusRef.current) {
        // Use requestAnimationFrame to ensure cleanup happens after React updates
        requestAnimationFrame(() => {
          previousFocusRef.current?.focus()
          previousFocusRef.current = null
        })
      }
    }
  }, [isActive, autoFocus, restoreFocus, getFocusableElements])

  return containerRef
}

export default useFocusTrap
