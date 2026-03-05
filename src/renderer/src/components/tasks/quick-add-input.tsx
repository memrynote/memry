import { useState, useRef, useCallback, useMemo } from 'react'
import { Plus, Calendar, Folder, Flag } from 'lucide-react'

import { cn } from '@/lib/utils'

// ============================================================================
// TOKEN HIGHLIGHT OVERLAY
// ============================================================================

type TokenKind = 'date' | 'priority' | 'project' | 'plain'

interface Token {
  text: string
  kind: TokenKind
}

const TOKEN_STYLES: Record<Exclude<TokenKind, 'plain'>, string> = {
  date: 'text-amber-500 bg-amber-500/10 rounded px-0.5 -mx-0.5',
  priority: 'rounded px-0.5 -mx-0.5',
  project: 'text-blue-400 bg-blue-400/10 rounded px-0.5 -mx-0.5'
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'text-red-400 bg-red-400/10',
  u: 'text-red-400 bg-red-400/10',
  high: 'text-orange-400 bg-orange-400/10',
  h: 'text-orange-400 bg-orange-400/10',
  medium: 'text-amber-400 bg-amber-400/10',
  med: 'text-amber-400 bg-amber-400/10',
  m: 'text-amber-400 bg-amber-400/10',
  low: 'text-blue-400 bg-blue-400/10',
  l: 'text-blue-400 bg-blue-400/10',
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
          const colorClass = PRIORITY_COLORS[keyword] ?? 'text-orange-400 bg-orange-400/10'
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
  getParsePreview,
  hasSpecialSyntax,
  getDateOptions,
  getPriorityOptions,
  getProjectOptions,
  resolveDateDay
} from '@/lib/quick-add-parser'
import { priorityConfig, type Priority } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'
import { formatDateShort } from '@/lib/task-utils'
import {
  QuickOptionsBar,
  AutocompleteDropdown,
  QuickAddHelp,
  type AutocompleteType,
  type AutocompleteOption
} from './quick-add'

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
}

// ============================================================================
// PRIORITY DOT COMPONENT
// ============================================================================

const PriorityDot = ({
  priority,
  className
}: {
  priority: Priority
  className?: string
}): React.JSX.Element | null => {
  const config = priorityConfig[priority]
  if (!config.color) return null

  return (
    <span
      className={cn('size-2.5 shrink-0 rounded-full', className)}
      style={{ backgroundColor: config.color }}
      aria-hidden="true"
    />
  )
}

// ============================================================================
// PARSE PREVIEW COMPONENT
// ============================================================================

interface ParsePreviewProps {
  dueDate: Date | null
  priority: Priority
  projectName: string | null
}

const ParsePreview = ({
  dueDate,
  priority,
  projectName
}: ParsePreviewProps): React.JSX.Element | null => {
  const items: React.ReactNode[] = []

  // Due date preview
  if (dueDate) {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const isToday = dueDate.getTime() === today.getTime()
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const isTomorrow = dueDate.getTime() === tomorrow.getTime()

    let dateLabel = formatDateShort(dueDate)
    if (isToday) dateLabel = 'Today'
    if (isTomorrow) dateLabel = 'Tomorrow'

    items.push(
      <span key="date" className="flex items-center gap-1.5">
        <Calendar className="size-3.5 text-amber-500" />
        <span className="text-amber-600">{dateLabel}</span>
      </span>
    )
  }

  // Priority preview
  if (priority !== 'none') {
    const config = priorityConfig[priority]
    items.push(
      <span key="priority" className="flex items-center gap-1.5">
        <PriorityDot priority={priority} />
        <span style={{ color: config.color || undefined }}>{config.label}</span>
      </span>
    )
  }

  // Project preview
  if (projectName) {
    items.push(
      <span key="project" className="flex items-center gap-1.5">
        <Folder className="size-3.5 text-muted-foreground" />
        <span>{projectName}</span>
      </span>
    )
  }

  if (items.length === 0) return null

  return (
    <div className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground border-t border-border bg-muted/30">
      {items.map((item, index) => (
        <span key={index} className="flex items-center gap-1.5">
          {index > 0 && <span className="text-border">·</span>}
          {item}
        </span>
      ))}
    </div>
  )
}

// ============================================================================
// QUICK ADD INPUT COMPONENT
// ============================================================================

export const QuickAddInput = ({
  onAdd,
  onOpenModal,
  projects,
  placeholder = 'Add task...',
  className
}: QuickAddInputProps): React.JSX.Element => {
  const [value, setValue] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

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
      '!!urgent': 'text-red-500',
      '!!high': 'text-orange-500',
      '!!medium': 'text-amber-500',
      '!!low': 'text-blue-400'
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
              <span className="relative flex items-center justify-center w-4 h-4 text-amber-500">
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
          icon: <Folder className="size-4 text-blue-400" />
        }))
      }
      default:
        return []
    }
  }, [autocompleteType, autocompleteQuery, projects])

  // Parse preview data
  const preview = useMemo(() => {
    if (!value.trim() || !hasSpecialSyntax(value)) {
      return null
    }
    return getParsePreview(value, projects)
  }, [value, projects])

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

  // Insert text from quick options or autocomplete
  const handleInsert = useCallback((text: string): void => {
    setValue((prev) => {
      const trimmed = prev.trimEnd()
      return trimmed ? `${trimmed} ${text}` : text
    })
    inputRef.current?.focus()
  }, [])

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

  const showPreview =
    isFocused && preview && (preview.hasDate || preview.hasPriority || preview.hasProject)
  const showQuickOptions = isFocused && !showAutocomplete && !value.trim()

  return (
    <div className="relative">
      <div
        role="button"
        tabIndex={-1}
        onClick={handleContainerClick}
        className={cn(
          'flex flex-col rounded-md border transition-all duration-150 overflow-hidden',
          isFocused
            ? 'border-primary bg-background shadow-sm'
            : 'border-transparent bg-muted/50 hover:bg-muted',
          className
        )}
      >
        <div className="flex items-center gap-3 px-3 py-2.5">
          {/* Checkbox placeholder / Plus icon */}
          <div
            className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
              isFocused ? 'border-text-tertiary' : 'border-transparent'
            )}
          >
            {!isFocused && <Plus className="size-4 text-text-tertiary" aria-hidden="true" />}
          </div>

          {/* Input with token highlight overlay */}
          <div className="relative flex-1 min-w-0">
            <div
              ref={overlayRef}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre text-sm leading-[normal]"
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
                'relative w-full bg-transparent text-sm outline-none caret-text-primary',
                value && hasSpecialSyntax(value)
                  ? 'text-transparent selection:bg-primary/20 selection:text-transparent placeholder:text-text-tertiary'
                  : isFocused
                    ? 'text-text-primary placeholder:text-text-tertiary'
                    : 'text-text-tertiary placeholder:text-text-tertiary'
              )}
              aria-label="Quick add task"
            />
          </div>

          {/* Help icon when not focused */}
          {!isFocused && <QuickAddHelp />}

          {/* Keyboard hint when focused with content */}
          {isFocused && value.trim() && onOpenModal && (
            <span className="shrink-0 text-xs text-muted-foreground">
              <kbd className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">⌘↵</kbd> for
              more options
            </span>
          )}
        </div>

        {/* Bottom slot — always reserves height to prevent layout shift on blur */}
        {showPreview && preview ? (
          <ParsePreview
            dueDate={preview.dueDate}
            priority={preview.priority}
            projectName={preview.projectName}
          />
        ) : (
          <div
            className={cn(
              'px-3 pb-2 transition-opacity duration-150',
              showQuickOptions ? 'opacity-100' : 'opacity-0 pointer-events-none'
            )}
          >
            <QuickOptionsBar onInsert={handleInsert} />
          </div>
        )}
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
