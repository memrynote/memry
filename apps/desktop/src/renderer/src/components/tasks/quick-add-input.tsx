import { useState, useRef, useCallback, useMemo } from 'react'
import { Calendar, Folder, Flag } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/kbd'
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts-base'

// ============================================================================
// TOKEN HIGHLIGHT OVERLAY
// ============================================================================

type TokenKind = 'date' | 'priority' | 'project' | 'plain'

interface Token {
  text: string
  kind: TokenKind
}

const TOKEN_STYLES: Record<Exclude<TokenKind, 'plain'>, string> = {
  date: 'text-task-token-date bg-task-token-date/10 rounded px-0.5 -mx-0.5',
  priority: 'rounded px-0.5 -mx-0.5',
  project: 'text-task-token-project bg-task-token-project/10 rounded px-0.5 -mx-0.5'
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'text-task-priority-urgent bg-task-priority-urgent/10',
  u: 'text-task-priority-urgent bg-task-priority-urgent/10',
  high: 'text-task-priority-high bg-task-priority-high/10',
  h: 'text-task-priority-high bg-task-priority-high/10',
  medium: 'text-task-priority-medium bg-task-priority-medium/10',
  med: 'text-task-priority-medium bg-task-priority-medium/10',
  m: 'text-task-priority-medium bg-task-priority-medium/10',
  low: 'text-task-priority-low bg-task-priority-low/10',
  l: 'text-task-priority-low bg-task-priority-low/10',
  none: 'text-muted-foreground bg-muted/50',
  n: 'text-muted-foreground bg-muted/50'
}

function tokenize(input: string): Token[] {
  const regex = /(!![a-zA-Z]+|(?<![!])![a-zA-Z0-9]+|#[\w-]+)/g
  const tokens: Token[] = []
  let lastIndex = 0

  for (const match of input.matchAll(regex)) {
    const start = match.index!
    if (start > lastIndex) {
      tokens.push({ text: input.slice(lastIndex, start), kind: 'plain' })
    }

    const raw = match[0]
    if (raw.startsWith('!!')) {
      tokens.push({ text: raw, kind: 'priority' })
    } else if (raw.startsWith('!')) {
      tokens.push({ text: raw, kind: 'date' })
    } else {
      tokens.push({ text: raw, kind: 'project' })
    }
    lastIndex = start + raw.length
  }

  if (lastIndex < input.length) {
    tokens.push({ text: input.slice(lastIndex), kind: 'plain' })
  }

  return tokens
}

const TokenOverlay = ({ value }: { value: string }): React.JSX.Element => {
  const tokens = useMemo(() => tokenize(value), [value])

  return (
    <span>
      {tokens.map((token, i) => {
        if (token.kind === 'plain') {
          return (
            <span key={i} className="text-text-primary">
              {token.text}
            </span>
          )
        }

        if (token.kind === 'priority') {
          const keyword = token.text.slice(2).toLowerCase()
          const colorClass =
            PRIORITY_COLORS[keyword] ?? 'text-task-priority-high bg-task-priority-high/10'
          return (
            <span key={i} className={cn(TOKEN_STYLES.priority, colorClass)}>
              {token.text}
            </span>
          )
        }

        return (
          <span key={i} className={TOKEN_STYLES[token.kind]}>
            {token.text}
          </span>
        )
      })}
    </span>
  )
}
import {
  parseQuickAdd,
  hasSpecialSyntax,
  getDateOptions,
  getPriorityOptions,
  getProjectOptions,
  resolveDateDay
} from '@/lib/quick-add-parser'
import type { Priority } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'
import { AutocompleteDropdown, type AutocompleteType, type AutocompleteOption } from './quick-add'

// ============================================================================
// TYPES
// ============================================================================

interface QuickAddInputProps {
  onAdd: (
    title: string,
    parsedData?: {
      dueDate: Date | null
      priority: Priority
      projectId: string | null
    }
  ) => void
  onOpenModal?: (prefillTitle: string) => void
  projects: Project[]
  placeholder?: string
  className?: string
  compact?: boolean
  projectColor?: string
}

// ============================================================================
// QUICK ADD INPUT COMPONENT
// ============================================================================

export const QuickAddInput = ({
  onAdd,
  onOpenModal,
  projects,
  placeholder = 'Add a task...    !today  !!high  #project',
  className,
  compact = false,
  projectColor = '#6B7280'
}: QuickAddInputProps): React.JSX.Element => {
  const [value, setValue] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  useKeyboardShortcuts([
    {
      key: 'q',
      action: () => inputRef.current?.focus(),
      description: 'Focus quick add input'
    }
  ])

  // Detect triggers for autocomplete - compute during render instead of useEffect
  const { showAutocomplete, autocompleteType, autocompleteQuery } = useMemo(() => {
    if (!isFocused) {
      return {
        showAutocomplete: false,
        autocompleteType: null as AutocompleteType,
        autocompleteQuery: ''
      }
    }

    const lastWord = value.split(' ').pop() || ''

    // Check for priority trigger first (!! before !)
    if (lastWord.startsWith('!!')) {
      return {
        showAutocomplete: true,
        autocompleteType: 'priority' as AutocompleteType,
        autocompleteQuery: lastWord.slice(2)
      }
    } else if (lastWord.startsWith('!')) {
      // Date trigger (single !)
      return {
        showAutocomplete: true,
        autocompleteType: 'date' as AutocompleteType,
        autocompleteQuery: lastWord.slice(1)
      }
    } else if (lastWord.startsWith('#')) {
      // Project trigger
      return {
        showAutocomplete: true,
        autocompleteType: 'project' as AutocompleteType,
        autocompleteQuery: lastWord.slice(1)
      }
    } else {
      return {
        showAutocomplete: false,
        autocompleteType: null as AutocompleteType,
        autocompleteQuery: ''
      }
    }
  }, [value, isFocused])

  // Get autocomplete options based on type and query
  const autocompleteOptions = useMemo((): AutocompleteOption[] => {
    if (!autocompleteType) return []

    const PRIORITY_ICON_COLORS: Record<string, string> = {
      '!!urgent': 'text-task-priority-urgent',
      '!!high': 'text-task-priority-high',
      '!!medium': 'text-task-priority-medium',
      '!!low': 'text-task-priority-low'
    }

    switch (autocompleteType) {
      case 'date': {
        const opts = getDateOptions(autocompleteQuery)
        return opts.map((o) => {
          const keyword = o.value.slice(1)
          const day = resolveDateDay(keyword)
          return {
            value: o.value,
            label: o.label,
            icon: (
              <span className="relative flex items-center justify-center w-4 h-4 text-task-token-date">
                <Calendar className="size-4" />
                {day !== null && (
                  <span className="absolute text-[6px] font-bold leading-none mt-[3px]">{day}</span>
                )}
              </span>
            )
          }
        })
      }
      case 'priority': {
        const opts = getPriorityOptions(autocompleteQuery)
        return opts.map((o) => ({
          value: o.value,
          label: o.label,
          icon: (
            <Flag
              className={cn('size-4', PRIORITY_ICON_COLORS[o.value] ?? 'text-muted-foreground')}
            />
          )
        }))
      }
      case 'project': {
        const opts = getProjectOptions(autocompleteQuery, projects)
        return opts.map((o) => ({
          value: o.value,
          label: o.label,
          icon: <Folder className="size-4 text-task-token-project" />
        }))
      }
      default:
        return []
    }
  }, [autocompleteType, autocompleteQuery, projects])

  const handleSubmit = useCallback((): void => {
    const trimmedValue = value.trim()
    if (!trimmedValue) return

    // Parse the input
    const parsed = parseQuickAdd(trimmedValue, projects)

    // Call onAdd with title and parsed data
    onAdd(parsed.title, {
      dueDate: parsed.dueDate,
      priority: parsed.priority,
      projectId: parsed.projectId
    })

    setValue('')
    // Keep focus for rapid entry
    inputRef.current?.focus()
  }, [value, projects, onAdd])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // Let autocomplete handle navigation keys when visible
    if (showAutocomplete && autocompleteOptions.length > 0) {
      if (['ArrowDown', 'ArrowUp', 'Tab'].includes(e.key)) {
        return // Let AutocompleteDropdown handle these
      }
      if (e.key === 'Enter') {
        return // Let AutocompleteDropdown handle selection
      }
      if (e.key === 'Escape') {
        // Close autocomplete by adding space (changes last word, hides dropdown)
        e.preventDefault()
        e.stopPropagation()
        setValue((prev) => prev + ' ')
        return
      }
    }

    if (e.key === 'Enter') {
      // Cmd/Ctrl+Enter opens modal
      if ((e.metaKey || e.ctrlKey) && onOpenModal) {
        e.preventDefault()
        const trimmedValue = value.trim()
        const parsed = parseQuickAdd(trimmedValue, projects)
        onOpenModal(parsed.title)
        setValue('')
        inputRef.current?.blur()
        return
      }

      // Regular Enter submits
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setValue('')
      inputRef.current?.blur()
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setValue(e.target.value)
    syncScroll()
  }

  const syncScroll = useCallback((): void => {
    if (inputRef.current && overlayRef.current) {
      overlayRef.current.scrollLeft = inputRef.current.scrollLeft
    }
  }, [])

  const handleFocus = (): void => {
    setIsFocused(true)
  }

  const handleBlur = (): void => {
    // Delay to allow click on autocomplete/chips
    setTimeout(() => {
      setIsFocused(false)
    }, 150)
  }

  const handleContainerClick = (): void => {
    inputRef.current?.focus()
  }

  // Insert from autocomplete (replaces the trigger word)
  const handleAutocompleteSelect = useCallback((selectedValue: string): void => {
    setValue((prev) => {
      const words = prev.split(' ')
      words.pop() // Remove the trigger word
      words.push(selectedValue)
      return words.join(' ') + ' '
    })
    inputRef.current?.focus()
  }, [])

  const handleAutocompleteClose = useCallback((): void => {
    // Close autocomplete by adding space (changes last word, hides dropdown)
    setValue((prev) => prev + ' ')
  }, [])

  return (
    <div className={cn('relative', compact && 'grow shrink basis-0 min-w-0')}>
      <div
        role="button"
        tabIndex={-1}
        onClick={handleContainerClick}
        className={cn(
          'flex flex-col border-[1.5px] border-dashed transition-all duration-150 overflow-hidden',
          compact ? 'rounded-md' : 'rounded-[10px]',
          !isFocused && (compact ? 'border-border hover:border-text-tertiary' : 'border-[#DAD9D4]'),
          className
        )}
        style={isFocused ? { borderColor: `${projectColor}99` } : undefined}
      >
        <div
          className={cn(
            'flex items-center',
            compact ? 'gap-1.5 px-2.5 py-1' : 'gap-2.5 px-3.5 py-2'
          )}
        >
          <svg
            width={compact ? '13' : '16'}
            height={compact ? '13' : '16'}
            viewBox={compact ? '0 0 13 13' : '0 0 18 18'}
            fill="none"
            className="shrink-0 transition-colors duration-150"
            style={{ color: projectColor }}
            aria-hidden="true"
          >
            {compact ? (
              <>
                <circle
                  cx="6.5"
                  cy="6.5"
                  r="5"
                  stroke="currentColor"
                  strokeWidth="1.1"
                  strokeDasharray="2.5 2.5"
                />
                <path
                  d="M6.5 4.5v4M4.5 6.5h4"
                  stroke="currentColor"
                  strokeWidth="1.1"
                  strokeLinecap="round"
                />
              </>
            ) : (
              <>
                <circle
                  cx="9"
                  cy="9"
                  r="7.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeDasharray="3 3"
                />
                <path
                  d="M9 6v6M6 9h6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </>
            )}
          </svg>

          {/* Input with token highlight overlay */}
          <div className="relative flex-1 min-w-0">
            <div
              ref={overlayRef}
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute inset-0 overflow-hidden whitespace-pre leading-[normal]',
                compact ? 'text-[12px]' : 'text-sm'
              )}
            >
              {value && hasSpecialSyntax(value) && <TokenOverlay value={value} />}
            </div>
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={handleChange}
              onScroll={syncScroll}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className={cn(
                'relative w-full bg-transparent outline-none caret-text-primary',
                compact ? 'text-[12px] leading-4' : 'text-sm',
                value && hasSpecialSyntax(value)
                  ? 'text-transparent selection:bg-primary/20 selection:text-transparent placeholder:text-muted-foreground/40'
                  : isFocused
                    ? 'text-text-primary placeholder:text-muted-foreground/40'
                    : 'text-muted-foreground placeholder:text-muted-foreground/40'
              )}
              aria-label="Quick add task"
            />
          </div>

          <div
            className={cn(
              'flex items-center ml-auto shrink-0 transition-opacity duration-150',
              isFocused ? 'opacity-0 pointer-events-none' : 'opacity-100'
            )}
          >
            {compact ? (
              <span className="rounded-[3px] px-1 bg-foreground/5 border border-border">
                <span className="text-[9px] text-text-tertiary font-[family-name:var(--font-mono)] font-medium leading-3">
                  Q
                </span>
              </span>
            ) : (
              <Kbd className="px-1.5 py-px text-xs leading-4">Q</Kbd>
            )}
          </div>
        </div>
      </div>

      {/* Autocomplete dropdown */}
      {showAutocomplete && autocompleteOptions.length > 0 && (
        <AutocompleteDropdown
          type={autocompleteType}
          options={autocompleteOptions}
          onSelect={handleAutocompleteSelect}
          onClose={handleAutocompleteClose}
        />
      )}
    </div>
  )
}

export default QuickAddInput
