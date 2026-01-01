/**
 * Autocomplete Hook
 *
 * Manages autocomplete state for text inputs with suggestion filtering,
 * keyboard navigation, and cursor-aware word extraction.
 *
 * @module hooks/use-autocomplete
 */

import { useState, useCallback, useMemo } from 'react'

// ============================================================================
// Types
// ============================================================================

/**
 * A single autocomplete suggestion.
 */
export interface AutocompleteSuggestion {
  /** Display label (e.g., "dateDiff") */
  label: string
  /** Optional parameter signature (e.g., "(date1, date2, unit)") */
  signature?: string
  /** Text to insert when selected (e.g., "dateDiff(") */
  insertText: string
  /** Type of suggestion for potential styling */
  type: 'function' | 'variable'
}

/**
 * Options for the useAutocomplete hook.
 */
export interface UseAutocompleteOptions {
  /** All available suggestions */
  suggestions: AutocompleteSuggestion[]
  /** Minimum characters before showing suggestions (default: 2) */
  minChars?: number
}

/**
 * Current word info extracted from input.
 */
export interface CurrentWord {
  /** The word being typed */
  word: string
  /** Start index in the input string */
  start: number
  /** End index in the input string */
  end: number
}

/**
 * Result returned by useAutocomplete hook.
 */
export interface UseAutocompleteResult {
  // State
  /** Whether the dropdown is visible */
  isOpen: boolean
  /** Filtered suggestions based on current word */
  filteredSuggestions: AutocompleteSuggestion[]
  /** Currently selected index in the suggestions list */
  selectedIndex: number
  /** Current word being typed */
  currentWord: CurrentWord | null

  // Handlers
  /**
   * Call this when input value or cursor position changes.
   * @param value - Current input value
   * @param cursorPosition - Current cursor position in the input
   */
  handleInputChange: (value: string, cursorPosition: number) => void

  /**
   * Keyboard event handler - attach to input's onKeyDown.
   * Returns true if the event was handled (should preventDefault).
   */
  handleKeyDown: (e: React.KeyboardEvent) => boolean

  /**
   * Select a suggestion by index.
   * Returns the new input value with the suggestion inserted.
   */
  selectSuggestion: (index: number, currentValue: string) => string | null

  /**
   * Close the autocomplete dropdown.
   */
  close: () => void

  /**
   * Accept the currently selected suggestion.
   * Returns the new input value, or null if nothing selected.
   */
  acceptSelected: (currentValue: string) => string | null
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract the current word at the cursor position.
 * Words can contain letters, numbers, underscores, and dots.
 */
function getCurrentWord(value: string, cursorPosition: number): CurrentWord {
  // Find word boundaries
  const beforeCursor = value.slice(0, cursorPosition)

  // Find start of word (scan backwards for word characters)
  const wordMatch = beforeCursor.match(/[\w.]+$/)
  const word = wordMatch ? wordMatch[0] : ''
  const start = cursorPosition - word.length

  // For end, we just use cursor position (don't extend past cursor)
  const end = cursorPosition

  return { word, start, end }
}

/**
 * Filter suggestions based on the current word.
 * Case-insensitive prefix matching.
 */
function filterSuggestions(
  suggestions: AutocompleteSuggestion[],
  word: string
): AutocompleteSuggestion[] {
  if (!word) return []

  const lowerWord = word.toLowerCase()
  return suggestions.filter((s) => s.label.toLowerCase().startsWith(lowerWord))
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for managing autocomplete state in text inputs.
 *
 * @example
 * ```tsx
 * const {
 *   isOpen,
 *   filteredSuggestions,
 *   selectedIndex,
 *   handleInputChange,
 *   handleKeyDown,
 *   selectSuggestion
 * } = useAutocomplete({
 *   suggestions: FORMULA_SUGGESTIONS,
 *   minChars: 2
 * })
 *
 * <textarea
 *   value={value}
 *   onChange={(e) => {
 *     setValue(e.target.value)
 *     handleInputChange(e.target.value, e.target.selectionStart ?? 0)
 *   }}
 *   onKeyDown={(e) => {
 *     if (handleKeyDown(e)) {
 *       e.preventDefault()
 *     }
 *   }}
 * />
 * ```
 */
export function useAutocomplete({
  suggestions,
  minChars = 2
}: UseAutocompleteOptions): UseAutocompleteResult {
  // State
  const [isOpen, setIsOpen] = useState(false)
  const [currentWord, setCurrentWord] = useState<CurrentWord | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Filter suggestions based on current word
  const filteredSuggestions = useMemo(() => {
    if (!currentWord || currentWord.word.length < minChars) {
      return []
    }
    return filterSuggestions(suggestions, currentWord.word)
  }, [suggestions, currentWord, minChars])

  // Update open state based on filtered suggestions
  const shouldBeOpen = filteredSuggestions.length > 0

  // Handle input change
  const handleInputChange = useCallback(
    (value: string, cursorPosition: number) => {
      const word = getCurrentWord(value, cursorPosition)
      setCurrentWord(word)

      // Check if we should show suggestions
      if (word.word.length >= minChars) {
        const filtered = filterSuggestions(suggestions, word.word)
        if (filtered.length > 0) {
          setIsOpen(true)
          setSelectedIndex(0) // Reset selection when suggestions change
        } else {
          setIsOpen(false)
        }
      } else {
        setIsOpen(false)
      }
    },
    [suggestions, minChars]
  )

  // Close dropdown
  const close = useCallback(() => {
    setIsOpen(false)
    setSelectedIndex(0)
  }, [])

  // Select a suggestion and return the new value
  const selectSuggestion = useCallback(
    (index: number, currentValue: string): string | null => {
      const suggestion = filteredSuggestions[index]
      if (!suggestion || !currentWord) return null

      // Replace the current word with the suggestion's insertText
      const before = currentValue.slice(0, currentWord.start)
      const after = currentValue.slice(currentWord.end)
      const newValue = before + suggestion.insertText + after

      // Close dropdown
      close()

      return newValue
    },
    [filteredSuggestions, currentWord, close]
  )

  // Accept currently selected suggestion
  const acceptSelected = useCallback(
    (currentValue: string): string | null => {
      if (!isOpen || filteredSuggestions.length === 0) return null
      return selectSuggestion(selectedIndex, currentValue)
    },
    [isOpen, filteredSuggestions, selectedIndex, selectSuggestion]
  )

  // Keyboard handler
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      // Only handle if dropdown is open
      if (!isOpen || filteredSuggestions.length === 0) {
        return false
      }

      switch (e.key) {
        case 'ArrowDown':
          setSelectedIndex((i) => Math.min(i + 1, filteredSuggestions.length - 1))
          return true

        case 'ArrowUp':
          setSelectedIndex((i) => Math.max(i - 1, 0))
          return true

        case 'Tab':
        case 'Enter':
          // Only handle if we have suggestions
          if (filteredSuggestions.length > 0) {
            return true // Signal that we want to handle this
          }
          return false

        case 'Escape':
          close()
          return true

        default:
          return false
      }
    },
    [isOpen, filteredSuggestions, close]
  )

  return {
    isOpen: shouldBeOpen && isOpen,
    filteredSuggestions,
    selectedIndex,
    currentWord,
    handleInputChange,
    handleKeyDown,
    selectSuggestion,
    close,
    acceptSelected
  }
}

export default useAutocomplete
