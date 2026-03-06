/**
 * Formula Editor Modal Component
 *
 * Dialog for creating and editing formula columns.
 * Features live preview, syntax hints, validation, and autocomplete.
 *
 * @module components/folder-view/formula-editor-modal
 */

import { useState, useCallback, useMemo, useRef } from 'react'
import { AlertCircle, HelpCircle } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { AutocompleteDropdown } from '@/components/ui/autocomplete-dropdown'
import { cn } from '@/lib/utils'
import { validateExpression } from '@/lib/expression-parser'
import { evaluateFormula, getBuiltInFunctions } from '@/lib/expression-evaluator'
import { useAutocomplete, type AutocompleteSuggestion } from '@/hooks/use-autocomplete'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:FormulaEditorModal')

// ============================================================================
// Types
// ============================================================================

interface FormulaEditorModalProps {
  /** Whether the modal is open */
  open: boolean
  /** Called when open state changes */
  onOpenChange: (open: boolean) => void
  /** Initial formula name (for editing) */
  initialName?: string
  /** Initial expression (for editing) */
  initialExpression?: string
  /** Sample note for preview */
  sampleNote?: NoteWithProperties | null
  /** Called when formula is saved */
  onSave: (name: string, expression: string) => Promise<void>
  /** Existing formula names (for duplicate check) */
  existingNames?: string[]
  /** Available properties from the folder (for autocomplete) */
  availableProperties?: Array<{ name: string; type: string }>
}

// ============================================================================
// Constants
// ============================================================================

const FUNCTION_HELP = `
Date Functions:
  today() - Current date (midnight)
  now() - Current datetime
  dateDiff(d1, d2, unit) - Difference between dates
    units: "days", "hours", "minutes", "weeks", "months", "years"
  dateAdd(date, amount, unit) - Add to date
  formatDate(date, format) - Format date

Conditional:
  if(condition, trueVal, falseVal) - Conditional
  coalesce(v1, v2, ...) - First non-null value
  default(value, defaultVal) - Default if empty

String Functions:
  concat(s1, s2, ...) - Join strings
  lower(s) / upper(s) - Case conversion
  trim(s) - Remove whitespace
  substring(s, start, end?) - Extract part
  replace(s, search, replacement) - Replace text
  contains(s, search) - Check if contains
  startsWith(s, prefix) / endsWith(s, suffix)
  length(s) - String length

Number Functions:
  round(n, decimals?) - Round number
  floor(n) / ceil(n) - Floor/ceiling
  abs(n) - Absolute value
  min(n1, n2, ...) / max(n1, n2, ...)
  sum(n1, n2, ...) / avg(n1, n2, ...)
  toFixed(n, decimals) - Format number

Array Functions:
  length(arr) - Array length
  join(arr, separator) - Join array
  first(arr) / last(arr) - Get element
  contains(arr, item) - Check if contains

Type Conversion:
  number(v) / string(v) / boolean(v)

Available Variables:
  - Any note property by name (e.g., status, priority)
  - title, tags, created, modified, wordCount
  - file.name, file.path, file.folder, file.created
  - note.title, note.tags, note.wordCount
`.trim()

// ============================================================================
// Base Autocomplete Suggestions
// ============================================================================

const BASE_SUGGESTIONS: AutocompleteSuggestion[] = [
  // Date functions
  { label: 'today', signature: '()', insertText: 'today()', type: 'function' },
  { label: 'now', signature: '()', insertText: 'now()', type: 'function' },
  {
    label: 'dateDiff',
    signature: '(date1, date2, unit)',
    insertText: 'dateDiff(',
    type: 'function'
  },
  { label: 'dateAdd', signature: '(date, amount, unit)', insertText: 'dateAdd(', type: 'function' },
  { label: 'formatDate', signature: '(date, format)', insertText: 'formatDate(', type: 'function' },

  // Conditional
  { label: 'if', signature: '(condition, trueVal, falseVal)', insertText: 'if(', type: 'function' },
  { label: 'coalesce', signature: '(val1, val2, ...)', insertText: 'coalesce(', type: 'function' },
  { label: 'default', signature: '(value, defaultVal)', insertText: 'default(', type: 'function' },

  // String functions
  { label: 'concat', signature: '(str1, str2, ...)', insertText: 'concat(', type: 'function' },
  { label: 'lower', signature: '(str)', insertText: 'lower(', type: 'function' },
  { label: 'upper', signature: '(str)', insertText: 'upper(', type: 'function' },
  { label: 'trim', signature: '(str)', insertText: 'trim(', type: 'function' },
  {
    label: 'substring',
    signature: '(str, start, end?)',
    insertText: 'substring(',
    type: 'function'
  },
  {
    label: 'replace',
    signature: '(str, search, replacement)',
    insertText: 'replace(',
    type: 'function'
  },
  { label: 'contains', signature: '(str, search)', insertText: 'contains(', type: 'function' },
  { label: 'startsWith', signature: '(str, prefix)', insertText: 'startsWith(', type: 'function' },
  { label: 'endsWith', signature: '(str, suffix)', insertText: 'endsWith(', type: 'function' },
  { label: 'length', signature: '(str | array)', insertText: 'length(', type: 'function' },

  // Number functions
  { label: 'round', signature: '(num, decimals?)', insertText: 'round(', type: 'function' },
  { label: 'floor', signature: '(num)', insertText: 'floor(', type: 'function' },
  { label: 'ceil', signature: '(num)', insertText: 'ceil(', type: 'function' },
  { label: 'abs', signature: '(num)', insertText: 'abs(', type: 'function' },
  { label: 'min', signature: '(num1, num2, ...)', insertText: 'min(', type: 'function' },
  { label: 'max', signature: '(num1, num2, ...)', insertText: 'max(', type: 'function' },
  { label: 'sum', signature: '(num1, num2, ...)', insertText: 'sum(', type: 'function' },
  { label: 'avg', signature: '(num1, num2, ...)', insertText: 'avg(', type: 'function' },
  { label: 'toFixed', signature: '(num, decimals)', insertText: 'toFixed(', type: 'function' },

  // Type conversion
  { label: 'number', signature: '(value)', insertText: 'number(', type: 'function' },
  { label: 'string', signature: '(value)', insertText: 'string(', type: 'function' },
  { label: 'boolean', signature: '(value)', insertText: 'boolean(', type: 'function' },

  // Array functions
  { label: 'join', signature: '(array, separator?)', insertText: 'join(', type: 'function' },
  { label: 'first', signature: '(array)', insertText: 'first(', type: 'function' },
  { label: 'last', signature: '(array)', insertText: 'last(', type: 'function' },
  { label: 'empty', signature: '(value)', insertText: 'empty(', type: 'function' },

  // Built-in variables
  { label: 'title', insertText: 'title', type: 'variable' },
  { label: 'tags', insertText: 'tags', type: 'variable' },
  { label: 'created', insertText: 'created', type: 'variable' },
  { label: 'modified', insertText: 'modified', type: 'variable' },
  { label: 'wordCount', insertText: 'wordCount', type: 'variable' },
  { label: 'folder', insertText: 'folder', type: 'variable' },
  { label: 'file.name', insertText: 'file.name', type: 'variable' },
  { label: 'file.path', insertText: 'file.path', type: 'variable' },
  { label: 'file.folder', insertText: 'file.folder', type: 'variable' },
  { label: 'file.created', insertText: 'file.created', type: 'variable' },
  { label: 'file.modified', insertText: 'file.modified', type: 'variable' },
  { label: 'note.title', insertText: 'note.title', type: 'variable' },
  { label: 'note.tags', insertText: 'note.tags', type: 'variable' },
  { label: 'note.wordCount', insertText: 'note.wordCount', type: 'variable' }
]

// ============================================================================
// Component
// ============================================================================

/**
 * Modal dialog for creating and editing formula columns.
 */
const EMPTY_NAMES: string[] = []
const EMPTY_PROPERTIES: Array<{ name: string; type: string }> = []

export function FormulaEditorModal({
  open,
  onOpenChange,
  initialName = '',
  initialExpression = '',
  sampleNote,
  onSave,
  existingNames = EMPTY_NAMES,
  availableProperties = EMPTY_PROPERTIES
}: FormulaEditorModalProps): React.JSX.Element {
  // Form state
  const [name, setName] = useState(initialName)
  const [expression, setExpression] = useState(initialExpression)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Ref for expression textarea
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Build suggestions list including user-defined properties
  const suggestions = useMemo(() => {
    const propertyVars: AutocompleteSuggestion[] = availableProperties.map((prop) => ({
      label: prop.name,
      signature: `(${prop.type})`,
      insertText: prop.name,
      type: 'variable' as const
    }))

    // Combine base suggestions with property variables, avoiding duplicates
    const baseLabels = new Set(BASE_SUGGESTIONS.map((s) => s.label))
    const uniqueProps = propertyVars.filter((p) => !baseLabels.has(p.label))

    return [...BASE_SUGGESTIONS, ...uniqueProps]
  }, [availableProperties])

  // Autocomplete hook
  const {
    isOpen: isAutocompleteOpen,
    filteredSuggestions,
    selectedIndex,
    handleInputChange: handleAutocompleteInput,
    handleKeyDown: handleAutocompleteKeyDown,
    selectSuggestion,
    acceptSelected,
    close: closeAutocomplete
  } = useAutocomplete({
    suggestions,
    minChars: 2
  })

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setName(initialName)
        setExpression(initialExpression)
        closeAutocomplete()
      }
      onOpenChange(nextOpen)
    },
    [initialName, initialExpression, closeAutocomplete, onOpenChange]
  )

  // Validation
  const nameError = useMemo(() => {
    if (!name.trim()) {
      return 'Name is required'
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name.trim())) {
      return 'Name must start with a letter and contain only letters, numbers, and underscores'
    }
    // Check for duplicates (excluding the current name if editing)
    const isEditing = initialName && initialName === name.trim()
    if (!isEditing && existingNames.includes(name.trim())) {
      return 'A formula with this name already exists'
    }
    return null
  }, [name, existingNames, initialName])

  const expressionValidation = useMemo(() => {
    if (!expression.trim()) {
      return { valid: false, error: 'Expression is required' }
    }
    return validateExpression(expression)
  }, [expression])

  // Preview result
  const previewResult = useMemo(() => {
    if (!sampleNote || !expressionValidation.valid) {
      return null
    }
    try {
      const result = evaluateFormula(expression, sampleNote)
      return { success: true, value: result }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }, [expression, sampleNote, expressionValidation.valid])

  // Format preview value for display
  const formatPreviewValue = useCallback((value: unknown): string => {
    if (value === null || value === undefined) {
      return '(empty)'
    }
    if (value instanceof Date) {
      return value.toISOString()
    }
    if (Array.isArray(value)) {
      return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`
    }
    if (typeof value === 'object') {
      return JSON.stringify(value)
    }
    return String(value)
  }, [])

  // Handle save
  const handleSave = useCallback(async () => {
    if (nameError || !expressionValidation.valid) {
      return
    }

    setIsSubmitting(true)
    try {
      await onSave(name.trim(), expression.trim())
      handleOpenChange(false)
    } catch (err) {
      log.error('Failed to save formula', err)
    } finally {
      setIsSubmitting(false)
    }
  }, [name, expression, nameError, expressionValidation.valid, onSave, handleOpenChange])

  // Handle Enter key in name field
  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !nameError && expressionValidation.valid) {
        e.preventDefault()
        handleSave()
      }
    },
    [nameError, expressionValidation.valid, handleSave]
  )

  // Get available functions list
  const functions = useMemo(() => getBuiltInFunctions(), [])

  const isEditing = Boolean(initialName)
  const canSave = !nameError && expressionValidation.valid && !isSubmitting

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Formula' : 'Create Formula'}</DialogTitle>
          <DialogDescription>Define a computed column using an expression.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* Name Input */}
          <div className="grid gap-2">
            <Label htmlFor="formula-name">Name</Label>
            <Input
              id="formula-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleNameKeyDown}
              placeholder="days_until_due"
              className={cn(nameError && name && 'border-destructive')}
              disabled={isEditing} // Can't rename existing formula
            />
            {nameError && name && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {nameError}
              </p>
            )}
          </div>

          {/* Expression Input with Autocomplete */}
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="formula-expression">Expression</Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-6 w-6">
                      <HelpCircle className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="max-w-[400px] max-h-[400px] overflow-auto">
                    <pre className="text-xs whitespace-pre-wrap font-mono">{FUNCTION_HELP}</pre>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <div className="relative">
              <Textarea
                ref={textareaRef}
                id="formula-expression"
                value={expression}
                onChange={(e) => {
                  setExpression(e.target.value)
                  handleAutocompleteInput(e.target.value, e.target.selectionStart ?? 0)
                }}
                onKeyDown={(e) => {
                  // Handle autocomplete keyboard events
                  if (handleAutocompleteKeyDown(e)) {
                    e.preventDefault()
                    // If Tab or Enter was pressed and we have suggestions, accept it
                    if ((e.key === 'Tab' || e.key === 'Enter') && filteredSuggestions.length > 0) {
                      const newValue = acceptSelected(expression)
                      if (newValue !== null) {
                        setExpression(newValue)
                        // Move cursor to end of inserted text
                        setTimeout(() => {
                          if (textareaRef.current) {
                            textareaRef.current.focus()
                            textareaRef.current.selectionStart = newValue.length
                            textareaRef.current.selectionEnd = newValue.length
                          }
                        }, 0)
                      }
                    }
                  }
                }}
                onBlur={() => {
                  // Delay close to allow click on dropdown
                  setTimeout(closeAutocomplete, 150)
                }}
                placeholder='dateDiff(due_date, today(), "days")'
                className={cn(
                  'font-mono text-sm min-h-[80px]',
                  !expressionValidation.valid && expression && 'border-destructive'
                )}
              />
              {/* Autocomplete Dropdown */}
              <AutocompleteDropdown
                suggestions={filteredSuggestions}
                selectedIndex={selectedIndex}
                visible={isAutocompleteOpen}
                onSelect={(index) => {
                  const newValue = selectSuggestion(index, expression)
                  if (newValue !== null) {
                    setExpression(newValue)
                    // Refocus textarea
                    setTimeout(() => {
                      textareaRef.current?.focus()
                    }, 0)
                  }
                }}
              />
            </div>
            {!expressionValidation.valid && expression && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {expressionValidation.error}
              </p>
            )}
          </div>

          {/* Function Hints */}
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Available: </span>
            {functions.slice(0, 8).join(', ')}
            {functions.length > 8 && `, +${functions.length - 8} more`}
          </div>

          {/* Preview */}
          <div className="grid gap-2">
            <Label>Preview</Label>
            <div
              className={cn(
                'rounded-md border p-3 text-sm font-mono bg-muted/50',
                !sampleNote && 'text-muted-foreground italic'
              )}
            >
              {!sampleNote ? (
                'No notes available for preview'
              ) : !expressionValidation.valid ? (
                <span className="text-muted-foreground italic">
                  Fix expression errors to see preview
                </span>
              ) : previewResult?.success ? (
                <span>{formatPreviewValue(previewResult.value)}</span>
              ) : (
                <span className="text-destructive">{previewResult?.error || 'Error'}</span>
              )}
            </div>
            {sampleNote && (
              <p className="text-xs text-muted-foreground">
                Using note: &quot;{sampleNote.title}&quot;
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {isSubmitting ? 'Saving...' : isEditing ? 'Update' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default FormulaEditorModal
