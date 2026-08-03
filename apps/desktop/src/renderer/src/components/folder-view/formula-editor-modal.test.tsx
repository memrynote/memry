import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FormulaEditorModal } from './formula-editor-modal'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  logError: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const leaf = key.split('.').at(-1) ?? key
      const interpolated = Object.values(values ?? {})
      return interpolated.length > 0 ? `${leaf}:${interpolated.join(',')}` : leaf
    }
  })
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: mocks.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({
    open,
    children
  }: {
    open: boolean
    onOpenChange?: (open: boolean) => void
    children: React.ReactNode
  }) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/autocomplete-dropdown', () => ({
  AutocompleteDropdown: ({
    suggestions,
    visible,
    onSelect
  }: {
    suggestions: Array<{ label: string }>
    visible: boolean
    onSelect: (index: number) => void
  }) =>
    visible ? (
      <div role="listbox">
        {suggestions.map((suggestion, index) => (
          <button type="button" key={suggestion.label} onClick={() => onSelect(index)}>
            {suggestion.label}
          </button>
        ))}
      </div>
    ) : null
}))

const sampleNote: NoteWithProperties = {
  id: 'note-1',
  path: 'Projects/Roadmap.md',
  title: 'Roadmap',
  emoji: null,
  folder: '/',
  tags: ['plan'],
  created: '2026-05-01T00:00:00.000Z',
  modified: '2026-05-02T00:00:00.000Z',
  wordCount: 42,
  properties: { priority: 3 }
}

describe('FormulaEditorModal', () => {
  beforeEach(() => {
    mocks.toastError.mockClear()
    mocks.logError.mockClear()
  })

  it('previews and saves a new formula, including autocomplete insertion', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onOpenChange = vi.fn()

    render(
      <FormulaEditorModal
        open
        onOpenChange={onOpenChange}
        sampleNote={sampleNote}
        onSave={onSave}
        availableProperties={[{ name: 'priority', type: 'number' }]}
      />
    )

    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'score' } })
    const expression = screen.getByLabelText('expression')
    fireEvent.change(expression, { target: { value: 'ti', selectionStart: 2 } })
    fireEvent.click(screen.getByRole('button', { name: 'title' }))
    expect(expression).toHaveValue('title')

    fireEvent.change(expression, { target: { value: 'wordCount' } })
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('usingNoteTitle:Roadmap')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('score', 'wordCount')
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('blocks invalid names and duplicate formulas', () => {
    render(
      <FormulaEditorModal
        open
        onOpenChange={vi.fn()}
        sampleNote={null}
        onSave={vi.fn()}
        existingNames={['score']}
      />
    )

    fireEvent.change(screen.getByLabelText('name'), { target: { value: '1bad' } })
    expect(screen.getByText(/Name must start/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'score' } })
    expect(screen.getByText('A formula with this name already exists')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('expression'), { target: { value: 'wordCount +' } })
    expect(screen.getByText(/Unexpected/)).toBeInTheDocument()
    expect(screen.getByText('No notes available for preview')).toBeInTheDocument()
  })

  it('resets edit state on open changes and reports save failures', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('disk full'))
    const onOpenChange = vi.fn()

    render(
      <FormulaEditorModal
        open
        onOpenChange={onOpenChange}
        initialName="rank"
        initialExpression="wordCount"
        sampleNote={sampleNote}
        onSave={onSave}
      />
    )

    expect(screen.getByText('Edit Formula')).toBeInTheDocument()
    expect(screen.getByLabelText('name')).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    fireEvent.change(screen.getByLabelText('expression'), { target: { value: 'title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => {
      expect(mocks.logError).toHaveBeenCalledWith('Failed to save formula', expect.any(Error))
    })
    expect(mocks.toastError).toHaveBeenCalledWith('disk full')
  })
})
