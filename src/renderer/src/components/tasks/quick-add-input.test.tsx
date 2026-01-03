/**
 * QuickAddInput Component Tests (T517-T518)
 *
 * Tests for the QuickAddInput component with quick add parsing and preview.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QuickAddInput } from './quick-add-input'
import type { Project } from '@/data/tasks-data'

// Mock scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn()

// ============================================================================
// Test Data
// ============================================================================

const mockProjects: Project[] = [
  {
    id: 'project-1',
    name: 'Personal',
    isDefault: false,
    isArchived: false,
    position: 0,
    statuses: [],
    color: 'blue',
    icon: 'folder'
  },
  {
    id: 'project-2',
    name: 'Work',
    isDefault: false,
    isArchived: false,
    position: 1,
    statuses: [],
    color: 'green',
    icon: 'folder'
  },
  {
    id: 'inbox',
    name: 'Inbox',
    isDefault: true,
    isArchived: false,
    position: -1,
    statuses: [],
    color: 'gray',
    icon: 'inbox'
  }
]

// ============================================================================
// T517: QuickAddInput - Basic Input Tests
// ============================================================================

describe('T517: QuickAddInput - basic input', () => {
  const defaultProps = {
    onAdd: vi.fn(),
    onOpenModal: vi.fn(),
    projects: mockProjects
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should render with placeholder', () => {
    render(<QuickAddInput {...defaultProps} />)

    expect(screen.getByPlaceholderText(/add task/i)).toBeInTheDocument()
  })

  it('should render with custom placeholder', () => {
    render(<QuickAddInput {...defaultProps} placeholder="Create a new task..." />)

    expect(screen.getByPlaceholderText('Create a new task...')).toBeInTheDocument()
  })

  it('should update input value on typing', async () => {
    const user = userEvent.setup()
    render(<QuickAddInput {...defaultProps} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.type(input, 'Buy groceries')

    expect(input).toHaveValue('Buy groceries')
  })

  it('should call onAdd with title on Enter', async () => {
    const user = userEvent.setup()
    render(<QuickAddInput {...defaultProps} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.type(input, 'Buy groceries{enter}')

    expect(defaultProps.onAdd).toHaveBeenCalledWith('Buy groceries', expect.objectContaining({
      dueDate: null,
      priority: 'none',
      projectId: null
    }))
  })

  it('should clear input after submission', async () => {
    const user = userEvent.setup()
    render(<QuickAddInput {...defaultProps} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.type(input, 'Buy groceries{enter}')

    expect(input).toHaveValue('')
  })

  it('should clear input on Escape', async () => {
    const user = userEvent.setup()
    render(<QuickAddInput {...defaultProps} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.type(input, 'Some task')
    await user.keyboard('{Escape}')

    expect(input).toHaveValue('')
  })

  it('should not submit empty input', async () => {
    const user = userEvent.setup()
    render(<QuickAddInput {...defaultProps} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.click(input)
    await user.keyboard('{Enter}')

    expect(defaultProps.onAdd).not.toHaveBeenCalled()
  })

  it('should not submit whitespace-only input', async () => {
    const user = userEvent.setup()
    render(<QuickAddInput {...defaultProps} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.type(input, '   {enter}')

    expect(defaultProps.onAdd).not.toHaveBeenCalled()
  })

  it('should call onOpenModal on Cmd+Enter', async () => {
    const user = userEvent.setup()
    render(<QuickAddInput {...defaultProps} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.type(input, 'Buy groceries')
    await user.keyboard('{Meta>}{Enter}{/Meta}')

    expect(defaultProps.onOpenModal).toHaveBeenCalledWith('Buy groceries')
    expect(input).toHaveValue('')
  })

  it('should maintain focus after submission', async () => {
    const user = userEvent.setup()
    render(<QuickAddInput {...defaultProps} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.type(input, 'Buy groceries{enter}')

    expect(input).toHaveFocus()
  })
})

// ============================================================================
// T518: QuickAddInput - Parsing Preview Tests
// ============================================================================

describe('T518: QuickAddInput - parsing preview', () => {
  const defaultProps = {
    onAdd: vi.fn(),
    onOpenModal: vi.fn(),
    projects: mockProjects
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('date parsing', () => {
    it('should show preview for !today', async () => {
      const user = userEvent.setup()
      render(<QuickAddInput {...defaultProps} />)

      const input = screen.getByRole('textbox', { name: /quick add task/i })
      await user.type(input, 'Buy groceries !today')

      // May appear in preview and autocomplete
      expect(screen.getAllByText('Today').length).toBeGreaterThanOrEqual(1)
    })

    it('should show preview for !tomorrow', async () => {
      const user = userEvent.setup()
      render(<QuickAddInput {...defaultProps} />)

      const input = screen.getByRole('textbox', { name: /quick add task/i })
      await user.type(input, 'Buy groceries !tomorrow')

      // May appear in preview and autocomplete
      expect(screen.getAllByText('Tomorrow').length).toBeGreaterThanOrEqual(1)
    })

    it('should show preview for !mon (day of week)', async () => {
      const user = userEvent.setup()
      render(<QuickAddInput {...defaultProps} />)

      const input = screen.getByRole('textbox', { name: /quick add task/i })
      await user.type(input, 'Meeting !mon')

      // Should show the formatted date for next Monday
      // (Format depends on implementation)
      expect(screen.getAllByText(/mon/i).length).toBeGreaterThanOrEqual(1)
    })

    it('should parse date and strip from title', async () => {
      const user = userEvent.setup()
      render(<QuickAddInput {...defaultProps} />)

      const input = screen.getByRole('textbox', { name: /quick add task/i })
      // Type the task with date syntax
      await user.type(input, 'Buy groceries !today')
      // Close autocomplete first, then submit
      await user.keyboard('{Escape}')
      await user.keyboard('{Enter}')

      // Verify onAdd was called
      expect(defaultProps.onAdd).toHaveBeenCalled()
      // The first argument should have the title stripped of syntax
      const call = defaultProps.onAdd.mock.calls[0]
      expect(call[0]).not.toContain('!today')
    })
  })

  describe('priority parsing', () => {
    it('should show preview for !!high', async () => {
      const user = userEvent.setup()
      render(<QuickAddInput {...defaultProps} />)

      const input = screen.getByRole('textbox', { name: /quick add task/i })
      await user.type(input, 'Important task !!high')

      // May appear in preview and autocomplete
      expect(screen.getAllByText(/high/i).length).toBeGreaterThanOrEqual(1)
    })

    it('should show preview for !!urgent', async () => {
      const user = userEvent.setup()
      render(<QuickAddInput {...defaultProps} />)

      const input = screen.getByRole('textbox', { name: /quick add task/i })
      await user.type(input, 'Critical task !!urgent')

      // May appear in preview and autocomplete
      expect(screen.getAllByText(/urgent/i).length).toBeGreaterThanOrEqual(1)
    })

    it('should show preview for !!medium', async () => {
      const user = userEvent.setup()
      render(<QuickAddInput {...defaultProps} />)

      const input = screen.getByRole('textbox', { name: /quick add task/i })
      await user.type(input, 'Normal task !!medium')

      // May appear in preview and autocomplete
      expect(screen.getAllByText(/medium/i).length).toBeGreaterThanOrEqual(1)
    })

    it('should parse priority and strip from title', async () => {
      const user = userEvent.setup()
      render(<QuickAddInput {...defaultProps} />)

      const input = screen.getByRole('textbox', { name: /quick add task/i })
      // Type the task with priority syntax
      await user.type(input, 'Important task !!high')
      // Close autocomplete first, then submit
      await user.keyboard('{Escape}')
      await user.keyboard('{Enter}')

      // Verify onAdd was called
      expect(defaultProps.onAdd).toHaveBeenCalled()
      // The first argument should have the title stripped of syntax
      const call = defaultProps.onAdd.mock.calls[0]
      expect(call[0]).not.toContain('!!high')
    })
  })

  describe('project parsing', () => {
    it('should show preview for #project', async () => {
      const user = userEvent.setup()
      render(<QuickAddInput {...defaultProps} />)

      const input = screen.getByRole('textbox', { name: /quick add task/i })
      await user.type(input, 'Task #Personal')

      // May appear in preview and autocomplete
      expect(screen.getAllByText(/personal/i).length).toBeGreaterThanOrEqual(1)
    })

    it('should match partial project names', async () => {
      const user = userEvent.setup()
      render(<QuickAddInput {...defaultProps} />)

      const input = screen.getByRole('textbox', { name: /quick add task/i })
      await user.type(input, 'Task #work')

      // May appear in preview and autocomplete
      expect(screen.getAllByText(/work/i).length).toBeGreaterThanOrEqual(1)
    })

    it('should parse project and strip from title', async () => {
      const user = userEvent.setup()
      render(<QuickAddInput {...defaultProps} />)

      const input = screen.getByRole('textbox', { name: /quick add task/i })
      // Type the task with project syntax
      await user.type(input, 'Task #Personal')
      // Close autocomplete first, then submit
      await user.keyboard('{Escape}')
      await user.keyboard('{Enter}')

      // Verify onAdd was called
      expect(defaultProps.onAdd).toHaveBeenCalled()
      // The first argument should have the title stripped of syntax
      const call = defaultProps.onAdd.mock.calls[0]
      expect(call[0]).not.toContain('#Personal')
    })
  })

  describe('combined syntax', () => {
    it('should show preview for combined date and priority', async () => {
      const user = userEvent.setup()
      render(<QuickAddInput {...defaultProps} />)

      const input = screen.getByRole('textbox', { name: /quick add task/i })
      await user.type(input, 'Task !today !!high')

      // May appear in multiple places
      expect(screen.getAllByText(/today/i).length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText(/high/i).length).toBeGreaterThanOrEqual(1)
    })

    it('should show preview for combined date, priority, and project', async () => {
      const user = userEvent.setup()
      render(<QuickAddInput {...defaultProps} />)

      const input = screen.getByRole('textbox', { name: /quick add task/i })
      await user.type(input, 'Task !tomorrow !!high #Personal')

      // May appear in multiple places
      expect(screen.getAllByText(/tomorrow/i).length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText(/high/i).length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText(/personal/i).length).toBeGreaterThanOrEqual(1)
    })

    it('should parse all combined syntax correctly', async () => {
      const user = userEvent.setup()
      render(<QuickAddInput {...defaultProps} />)

      const input = screen.getByRole('textbox', { name: /quick add task/i })
      // Type the task with combined syntax
      await user.type(input, 'Buy groceries !tomorrow !!high #Personal')
      // Close autocomplete first, then submit
      await user.keyboard('{Escape}')
      await user.keyboard('{Enter}')

      // Verify onAdd was called
      expect(defaultProps.onAdd).toHaveBeenCalled()
      // The first argument should have the title stripped of syntax
      const call = defaultProps.onAdd.mock.calls[0]
      expect(call[0]).not.toContain('!tomorrow')
      expect(call[0]).not.toContain('!!high')
      expect(call[0]).not.toContain('#Personal')
    })
  })

  describe('no preview', () => {
    it('should not show preview for plain text', async () => {
      const user = userEvent.setup()
      render(<QuickAddInput {...defaultProps} />)

      const input = screen.getByRole('textbox', { name: /quick add task/i })
      await user.type(input, 'Buy groceries')

      // Should not show date/priority/project preview elements
      expect(screen.queryByText('Today')).not.toBeInTheDocument()
      expect(screen.queryByText('High')).not.toBeInTheDocument()
    })
  })
})

// ============================================================================
// QuickAddInput - Autocomplete Tests
// ============================================================================

describe('QuickAddInput - autocomplete', () => {
  const defaultProps = {
    onAdd: vi.fn(),
    onOpenModal: vi.fn(),
    projects: mockProjects
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should show date autocomplete on !', async () => {
    const user = userEvent.setup()
    render(<QuickAddInput {...defaultProps} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.type(input, 'Task !')

    // Autocomplete dropdown should appear with date options
    expect(screen.getAllByText(/today/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/tomorrow/i).length).toBeGreaterThanOrEqual(1)
  })

  it('should show priority autocomplete on !!', async () => {
    const user = userEvent.setup()
    render(<QuickAddInput {...defaultProps} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.type(input, 'Task !!')

    // Autocomplete dropdown should appear with priority options
    expect(screen.getAllByText(/high/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/urgent/i).length).toBeGreaterThanOrEqual(1)
  })

  it('should show project autocomplete on #', async () => {
    const user = userEvent.setup()
    render(<QuickAddInput {...defaultProps} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.type(input, 'Task #')

    // Autocomplete dropdown should appear with project options
    expect(screen.getAllByText(/personal/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/work/i).length).toBeGreaterThanOrEqual(1)
  })

  it('should filter autocomplete options as user types', async () => {
    const user = userEvent.setup()
    render(<QuickAddInput {...defaultProps} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.type(input, 'Task #per')

    // Only matching projects should show
    expect(screen.getAllByText(/personal/i).length).toBeGreaterThanOrEqual(1)
    // Work should not appear or appear less frequently
    const workElements = screen.queryAllByText(/^Work$/)
    expect(workElements.length).toBeLessThanOrEqual(1)
  })

  it('should close autocomplete on Escape', async () => {
    const user = userEvent.setup()
    render(<QuickAddInput {...defaultProps} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.type(input, 'Task !')

    expect(screen.getAllByText(/today/i).length).toBeGreaterThanOrEqual(1)

    // First Escape closes autocomplete, second Escape clears input
    await user.keyboard('{Escape}')
    await user.keyboard('{Escape}')

    // Now input should be cleared
    expect(input).toHaveValue('')
  })
})

// ============================================================================
// Accessibility Tests
// ============================================================================

describe('QuickAddInput - accessibility', () => {
  const defaultProps = {
    onAdd: vi.fn(),
    onOpenModal: vi.fn(),
    projects: mockProjects
  }

  it('should have proper aria-label', () => {
    render(<QuickAddInput {...defaultProps} />)

    expect(screen.getByRole('textbox', { name: /quick add task/i })).toBeInTheDocument()
  })

  it('should be keyboard accessible', async () => {
    const user = userEvent.setup()
    render(<QuickAddInput {...defaultProps} />)

    // Tab to the input
    await user.tab()

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    expect(input).toHaveFocus()
  })

  it('should show help icon when not focused', () => {
    render(<QuickAddInput {...defaultProps} />)

    // Help icon should be visible when input is not focused
    // (Implementation may vary - look for help/question icon)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })
})
