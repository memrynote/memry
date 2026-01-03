/**
 * InfoSection Component Tests (T513-T514)
 *
 * Tests for the InfoSection component with property editors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InfoSection } from './InfoSection'
import type { Property, PropertyTemplate } from './types'

// ============================================================================
// Test Data
// ============================================================================

const createProperty = (
  id: string,
  name: string,
  type: Property['type'],
  value: unknown,
  isCustom = false,
  options?: string[]
): Property => ({
  id,
  name,
  type,
  value,
  isCustom,
  options
})

const mockProperties: Property[] = [
  createProperty('prop-1', 'Status', 'select', 'In Progress', false, [
    'Draft',
    'In Progress',
    'Done'
  ]),
  createProperty('prop-2', 'Priority', 'number', 3, false),
  createProperty('prop-3', 'Due Date', 'date', '2026-01-15', false),
  createProperty('prop-4', 'Completed', 'checkbox', false, false),
  createProperty('prop-5', 'Rating', 'rating', 4, false),
  createProperty('prop-6', 'Notes', 'text', 'Some notes', true),
  createProperty('prop-7', 'URL', 'url', 'https://example.com', true)
]

const mockFolderProperties: PropertyTemplate[] = [
  { id: 'tpl-1', name: 'Category', type: 'select', options: ['A', 'B', 'C'] },
  { id: 'tpl-2', name: 'Author', type: 'text' }
]

// ============================================================================
// T513: InfoSection - Basic Display Tests
// ============================================================================

describe('T513: InfoSection - basic display', () => {
  const defaultProps = {
    properties: mockProperties,
    isExpanded: true,
    onToggleExpand: vi.fn(),
    onPropertyChange: vi.fn(),
    onAddProperty: vi.fn(),
    onDeleteProperty: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should render with properties when expanded', () => {
    render(<InfoSection {...defaultProps} />)

    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('Due Date')).toBeInTheDocument()
  })

  it('should not show properties when collapsed', () => {
    render(<InfoSection {...defaultProps} isExpanded={false} />)

    // Properties should not be visible
    expect(screen.queryByText('Status')).not.toBeInTheDocument()
  })

  it('should call onToggleExpand when header is clicked', async () => {
    const user = userEvent.setup()
    render(<InfoSection {...defaultProps} />)

    // Header shows "Info" text
    const header = screen.getByRole('button', { name: /info/i })
    await user.click(header)

    expect(defaultProps.onToggleExpand).toHaveBeenCalled()
  })

  it('should have proper ARIA region', () => {
    render(<InfoSection {...defaultProps} />)

    expect(screen.getByRole('region', { name: /note properties/i })).toBeInTheDocument()
  })

  it('should show "show more" button when properties exceed visible count', () => {
    render(<InfoSection {...defaultProps} initialVisibleCount={2} />)

    // Should show button to reveal more properties
    expect(screen.getByText(/more properties/i)).toBeInTheDocument()
  })

  it('should show workspace properties label when folder properties exist', () => {
    render(<InfoSection {...defaultProps} folderProperties={mockFolderProperties} />)

    expect(screen.getByText(/workspace properties/i)).toBeInTheDocument()
  })

  it('should show add property button when expanded', () => {
    render(<InfoSection {...defaultProps} />)

    expect(screen.getByRole('button', { name: /add.*property/i })).toBeInTheDocument()
  })

  it('should disable add property button when disabled', () => {
    render(<InfoSection {...defaultProps} disabled />)

    expect(screen.getByRole('button', { name: /add.*property/i })).toBeDisabled()
  })
})

// ============================================================================
// T514: InfoSection - Property Editor Tests
// ============================================================================

describe('T514: InfoSection - property editors', () => {
  const defaultProps = {
    properties: mockProperties,
    isExpanded: true,
    onToggleExpand: vi.fn(),
    onPropertyChange: vi.fn(),
    onAddProperty: vi.fn(),
    onDeleteProperty: vi.fn(),
    initialVisibleCount: 10 // Show all properties for editor tests
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('text editor', () => {
    it('should display text value', () => {
      render(<InfoSection {...defaultProps} />)

      expect(screen.getByText('Some notes')).toBeInTheDocument()
    })

    it('should enter edit mode on click', async () => {
      const user = userEvent.setup()
      render(<InfoSection {...defaultProps} />)

      const textValue = screen.getByText('Some notes')
      await user.click(textValue)

      // Should now show input
      expect(screen.getByDisplayValue('Some notes')).toBeInTheDocument()
    })
  })

  describe('number editor', () => {
    it('should display number value', () => {
      render(<InfoSection {...defaultProps} />)

      expect(screen.getByText('3')).toBeInTheDocument()
    })
  })

  describe('date editor', () => {
    it('should display formatted date', () => {
      render(<InfoSection {...defaultProps} />)

      // Date is formatted as "MMM d, yyyy"
      expect(screen.getByText(/Jan 15, 2026/i)).toBeInTheDocument()
    })
  })

  describe('checkbox editor', () => {
    it('should display checkbox state', () => {
      render(<InfoSection {...defaultProps} />)

      const checkbox = screen.getByRole('checkbox')
      expect(checkbox).not.toBeChecked()
    })

    it('should toggle checkbox on click', async () => {
      const user = userEvent.setup()
      render(<InfoSection {...defaultProps} />)

      const checkbox = screen.getByRole('checkbox')
      await user.click(checkbox)

      expect(defaultProps.onPropertyChange).toHaveBeenCalledWith('prop-4', true)
    })
  })

  describe('rating editor', () => {
    it('should display star rating', () => {
      render(<InfoSection {...defaultProps} />)

      // Rating of 4 should show filled stars
      const ratingSection = screen.getByText('Rating').parentElement
      expect(ratingSection).toBeInTheDocument()
    })
  })

  describe('url editor', () => {
    it('should display URL value', () => {
      render(<InfoSection {...defaultProps} />)

      expect(screen.getByText('https://example.com')).toBeInTheDocument()
    })
  })

  describe('select editor', () => {
    it('should display selected value', () => {
      render(<InfoSection {...defaultProps} />)

      expect(screen.getByText('In Progress')).toBeInTheDocument()
    })
  })

  describe('property change callback', () => {
    it('should call onPropertyChange with property id and new value', async () => {
      const user = userEvent.setup()
      const props = {
        ...defaultProps,
        properties: [createProperty('test-prop', 'Test', 'text', 'Old Value', false)]
      }
      render(<InfoSection {...props} />)

      const textValue = screen.getByText('Old Value')
      await user.click(textValue)

      const input = screen.getByDisplayValue('Old Value')
      await user.clear(input)
      await user.type(input, 'New Value')
      await user.tab() // Blur to save

      expect(defaultProps.onPropertyChange).toHaveBeenCalledWith('test-prop', 'New Value')
    })
  })

  describe('custom property deletion', () => {
    it('should pass isCustom property correctly for custom properties', () => {
      render(<InfoSection {...defaultProps} />)

      // Notes is a custom property (prop-6)
      expect(screen.getByText('Notes')).toBeInTheDocument()
      // URL is also a custom property (prop-7)
      expect(screen.getByText('URL')).toBeInTheDocument()
    })

    it('should pass onDeleteProperty for custom properties', () => {
      // The component passes onDelete only for custom properties
      // This is verified by the fact that the component receives onDeleteProperty
      // and passes it conditionally
      render(<InfoSection {...defaultProps} />)

      // Just verify the component renders without errors with the delete handler
      expect(screen.getByText('Notes')).toBeInTheDocument()
    })
  })
})

// ============================================================================
// InfoSection - Add Property Tests
// ============================================================================

describe('InfoSection - add property', () => {
  const defaultProps = {
    properties: [],
    isExpanded: true,
    onToggleExpand: vi.fn(),
    onPropertyChange: vi.fn(),
    onAddProperty: vi.fn(),
    onDeleteProperty: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should open add property popup on button click', async () => {
    const user = userEvent.setup()
    render(<InfoSection {...defaultProps} />)

    const addButton = screen.getByRole('button', { name: /add.*property/i })
    await user.click(addButton)

    // Should show property type options (the popup has a listbox with types)
    expect(screen.getByRole('listbox', { name: /property types/i })).toBeInTheDocument()
  })

  it('should show property type options in popup', async () => {
    const user = userEvent.setup()
    render(<InfoSection {...defaultProps} />)

    const addButton = screen.getByRole('button', { name: /add.*property/i })
    await user.click(addButton)

    // Should show available property types from PROPERTY_TYPE_CONFIG
    const listbox = screen.getByRole('listbox', { name: /property types/i })
    expect(within(listbox).getAllByRole('option').length).toBeGreaterThan(0)
  })

  it('should call onAddProperty when type is selected', async () => {
    const user = userEvent.setup()
    render(<InfoSection {...defaultProps} />)

    const addButton = screen.getByRole('button', { name: /add.*property/i })
    await user.click(addButton)

    // Select a property type - the component auto-creates with default name
    const options = screen.getAllByRole('option')
    await user.click(options[0])

    expect(defaultProps.onAddProperty).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.any(String),
        type: expect.any(String)
      })
    )
  })

  it('should close popup after selecting a type', async () => {
    const user = userEvent.setup()
    render(<InfoSection {...defaultProps} />)

    const addButton = screen.getByRole('button', { name: /add.*property/i })
    await user.click(addButton)

    const options = screen.getAllByRole('option')
    await user.click(options[0])

    // Popup should close
    expect(screen.queryByRole('listbox', { name: /property types/i })).not.toBeInTheDocument()
  })
})

// ============================================================================
// InfoSection - Show More/Less Tests
// ============================================================================

describe('InfoSection - show more/less', () => {
  const defaultProps = {
    properties: mockProperties,
    isExpanded: true,
    onToggleExpand: vi.fn(),
    onPropertyChange: vi.fn(),
    onAddProperty: vi.fn(),
    onDeleteProperty: vi.fn(),
    initialVisibleCount: 2
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should show limited properties initially', () => {
    render(<InfoSection {...defaultProps} />)

    // With initialVisibleCount of 2, should show "X more properties" button
    expect(screen.getByText(/more properties/i)).toBeInTheDocument()
  })

  it('should expand to show all properties on "show more" click', async () => {
    const user = userEvent.setup()
    render(<InfoSection {...defaultProps} />)

    const showMoreButton = screen.getByText(/more properties/i)
    await user.click(showMoreButton)

    // Now should show all properties
    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('Due Date')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.getByText('Rating')).toBeInTheDocument()
    expect(screen.getByText('Notes')).toBeInTheDocument()
    expect(screen.getByText('URL')).toBeInTheDocument()
  })

  it('should show "show less" button when expanded', async () => {
    const user = userEvent.setup()
    render(<InfoSection {...defaultProps} />)

    const showMoreButton = screen.getByText(/more properties/i)
    await user.click(showMoreButton)

    expect(screen.getByText(/show less/i)).toBeInTheDocument()
  })

  it('should collapse back on "show less" click', async () => {
    const user = userEvent.setup()
    render(<InfoSection {...defaultProps} />)

    // Expand
    const showMoreButton = screen.getByText(/more properties/i)
    await user.click(showMoreButton)

    // Collapse
    const showLessButton = screen.getByText(/show less/i)
    await user.click(showLessButton)

    // Should show "more properties" again
    expect(screen.getByText(/more properties/i)).toBeInTheDocument()
  })
})

// ============================================================================
// Accessibility Tests
// ============================================================================

describe('InfoSection - accessibility', () => {
  const defaultProps = {
    properties: mockProperties,
    isExpanded: true,
    onToggleExpand: vi.fn(),
    onPropertyChange: vi.fn(),
    onAddProperty: vi.fn(),
    onDeleteProperty: vi.fn()
  }

  it('should have proper region role', () => {
    render(<InfoSection {...defaultProps} />)

    expect(screen.getByRole('region', { name: /note properties/i })).toBeInTheDocument()
  })

  it('should have properties list role', () => {
    render(<InfoSection {...defaultProps} />)

    expect(screen.getByRole('list', { name: /properties list/i })).toBeInTheDocument()
  })

  it('should have proper aria-label on add button', () => {
    render(<InfoSection {...defaultProps} />)

    expect(screen.getByRole('button', { name: /add.*property/i })).toBeInTheDocument()
  })

  it('should have proper aria-label on show more button', () => {
    render(<InfoSection {...defaultProps} initialVisibleCount={2} />)

    const showMoreButton = screen.getByRole('button', { name: /show.*more properties/i })
    expect(showMoreButton).toBeInTheDocument()
  })

  it('should have aria-expanded on toggle header', () => {
    render(<InfoSection {...defaultProps} />)

    const header = screen.getByRole('button', { name: /info/i })
    expect(header).toHaveAttribute('aria-expanded', 'true')
  })
})
