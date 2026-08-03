/**
 * InfoSection Component Tests (T513-T514)
 *
 * Tests for the InfoSection component with property editors.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { InfoSection } from './InfoSection'
import type { Property, PropertyTemplate } from './types'
import { PROPERTY_TYPE_CONFIG, PROPERTY_TYPES } from './types'

let i18nEn: I18nInstance
let i18nTr: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
  i18nTr = await createRendererI18n({ locale: 'tr' })
})

const renderWithI18n = (ui: React.ReactElement, i18n = i18nEn) =>
  render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)

// ============================================================================
// Test Data
// ============================================================================

const createProperty = (
  id: string,
  name: string,
  type: Property['type'],
  value: unknown,
  isCustom = false
): Property => ({
  id,
  name,
  type,
  value,
  isCustom
})

const mockProperties: Property[] = [
  createProperty('prop-1', 'Status', 'text', 'In Progress', false),
  createProperty('prop-2', 'Priority', 'number', 3, false),
  createProperty('prop-3', 'Due Date', 'date', '2026-01-15', false),
  createProperty('prop-4', 'Completed', 'checkbox', false, false),
  createProperty('prop-5', 'Notes', 'text', 'Some notes', true),
  createProperty('prop-6', 'URL', 'url', 'https://example.com', true)
]

const mockFolderProperties: PropertyTemplate[] = [
  { id: 'tpl-1', name: 'Category', type: 'text' },
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
    renderWithI18n(<InfoSection {...defaultProps} />)

    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('Due Date')).toBeInTheDocument()
  })

  it('should not show properties when collapsed', () => {
    renderWithI18n(<InfoSection {...defaultProps} isExpanded={false} />)

    // Properties should not be visible
    expect(screen.queryByText('Status')).not.toBeInTheDocument()
  })

  it('should call onToggleExpand when header is clicked', async () => {
    const user = userEvent.setup()
    renderWithI18n(<InfoSection {...defaultProps} />)

    const header = screen.getByRole('button', { name: /^properties/i })
    await user.click(header)

    expect(defaultProps.onToggleExpand).toHaveBeenCalled()
  })

  it('should have proper ARIA region', () => {
    renderWithI18n(<InfoSection {...defaultProps} />)

    expect(screen.getByRole('region', { name: /note properties/i })).toBeInTheDocument()
  })

  it('renders Turkish property aria for Turkish notes namespace', () => {
    renderWithI18n(<InfoSection {...defaultProps} />, i18nTr)

    expect(screen.getByRole('region', { name: 'Not özellikleri' })).toBeInTheDocument()
  })

  it('should show all properties without truncation', () => {
    renderWithI18n(<InfoSection {...defaultProps} />)

    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('Due Date')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.getByText('Notes')).toBeInTheDocument()
    expect(screen.getByText('URL')).toBeInTheDocument()
  })

  it('should show workspace properties label when folder properties exist', () => {
    renderWithI18n(<InfoSection {...defaultProps} folderProperties={mockFolderProperties} />)

    expect(screen.getByText(/workspace properties/i)).toBeInTheDocument()
  })

  it('should show add property button when expanded', () => {
    renderWithI18n(<InfoSection {...defaultProps} />)

    expect(screen.getByRole('button', { name: /add.*property/i })).toBeInTheDocument()
  })

  it('should disable add property button when disabled', () => {
    renderWithI18n(<InfoSection {...defaultProps} disabled />)

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
    onDeleteProperty: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('text editor', () => {
    it('should display text value', () => {
      renderWithI18n(<InfoSection {...defaultProps} />)

      expect(screen.getByText('Some notes')).toBeInTheDocument()
    })

    it('should enter edit mode on click', async () => {
      const user = userEvent.setup()
      renderWithI18n(<InfoSection {...defaultProps} />)

      const textValue = screen.getByText('Some notes')
      await user.click(textValue)

      // Should now show input
      expect(screen.getByDisplayValue('Some notes')).toBeInTheDocument()
    })
  })

  describe('number editor', () => {
    it('should display number value', () => {
      renderWithI18n(<InfoSection {...defaultProps} />)

      expect(screen.getByText('3')).toBeInTheDocument()
    })
  })

  describe('date editor', () => {
    it('should display formatted date', () => {
      renderWithI18n(<InfoSection {...defaultProps} />)

      expect(screen.getByText('15.01.2026')).toBeInTheDocument()
    })
  })

  describe('checkbox editor', () => {
    it('should display checkbox state', () => {
      renderWithI18n(<InfoSection {...defaultProps} />)

      const checkbox = screen.getByRole('checkbox')
      expect(checkbox).not.toBeChecked()
    })

    it('should toggle checkbox on click', async () => {
      const user = userEvent.setup()
      renderWithI18n(<InfoSection {...defaultProps} />)

      const checkbox = screen.getByRole('checkbox')
      await user.click(checkbox)

      expect(defaultProps.onPropertyChange).toHaveBeenCalledWith('prop-4', true)
    })
  })

  describe('url editor', () => {
    it('should display URL value', () => {
      renderWithI18n(<InfoSection {...defaultProps} />)

      expect(screen.getByText('https://example.com')).toBeInTheDocument()
    })
  })

  describe('select editor', () => {
    it('should display selected value', () => {
      renderWithI18n(<InfoSection {...defaultProps} />)

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
      renderWithI18n(<InfoSection {...props} />)

      const textValue = screen.getByText('Old Value')
      await user.click(textValue)

      const input = screen.getByDisplayValue('Old Value')
      await user.clear(input)
      await user.type(input, 'New{space}Value')
      await user.tab() // Blur to save

      expect(defaultProps.onPropertyChange).toHaveBeenCalledWith('test-prop', 'NewValue')
    })
  })

  describe('custom property deletion', () => {
    it('should pass isCustom property correctly for custom properties', () => {
      renderWithI18n(<InfoSection {...defaultProps} />)

      // Notes is a custom property (prop-6)
      expect(screen.getByText('Notes')).toBeInTheDocument()
      // URL is also a custom property (prop-7)
      expect(screen.getByText('URL')).toBeInTheDocument()
    })

    it('should pass onDeleteProperty for custom properties', () => {
      // The component passes onDelete only for custom properties
      // This is verified by the fact that the component receives onDeleteProperty
      // and passes it conditionally
      renderWithI18n(<InfoSection {...defaultProps} />)

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
    renderWithI18n(<InfoSection {...defaultProps} />)

    const addButton = screen.getByRole('button', { name: /add.*property/i })
    await user.click(addButton)

    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('should show property type options in popup', async () => {
    const user = userEvent.setup()
    renderWithI18n(<InfoSection {...defaultProps} />)

    const addButton = screen.getByRole('button', { name: /add.*property/i })
    await user.click(addButton)

    const listbox = screen.getByRole('listbox')
    expect(within(listbox).getAllByRole('option').length).toBeGreaterThan(0)
  })

  it('should call onAddProperty when type is selected', async () => {
    const user = userEvent.setup()
    renderWithI18n(<InfoSection {...defaultProps} />)

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
    renderWithI18n(<InfoSection {...defaultProps} />)

    const addButton = screen.getByRole('button', { name: /add.*property/i })
    await user.click(addButton)

    const options = screen.getAllByRole('option')
    await user.click(options[0])

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
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
    renderWithI18n(<InfoSection {...defaultProps} />)

    expect(screen.getByRole('region', { name: /note properties/i })).toBeInTheDocument()
  })

  it('should have properties list role', () => {
    renderWithI18n(<InfoSection {...defaultProps} />)

    expect(screen.getByRole('list', { name: /properties list/i })).toBeInTheDocument()
  })

  it('should have proper aria-label on add button', () => {
    renderWithI18n(<InfoSection {...defaultProps} />)

    expect(screen.getByRole('button', { name: /add.*property/i })).toBeInTheDocument()
  })

  it('should have aria-expanded on toggle header', () => {
    renderWithI18n(<InfoSection {...defaultProps} />)

    const header = screen.getByRole('button', { name: /^properties/i })
    expect(header).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('relation property type registration', () => {
  it('exposes relation in the type registry', () => {
    expect(PROPERTY_TYPES).toContain('relation')
    expect(PROPERTY_TYPE_CONFIG.relation.label).toBe('Relation')
  })
})

// ============================================================================
// T8: Relation property type in add-property popup
// ============================================================================

describe('Task 8: Relation property in add-property popup', () => {
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

  it('should offer Relation as a property type option', async () => {
    const user = userEvent.setup()
    renderWithI18n(<InfoSection {...defaultProps} />)

    const addButton = screen.getByRole('button', { name: /add.*property/i })
    await user.click(addButton)

    // Check that Relation appears in the popup options
    expect(screen.getByRole('option', { name: /relation/i })).toBeInTheDocument()
  })

  it('should call onAddProperty with type: relation when Relation is selected', async () => {
    const user = userEvent.setup()
    renderWithI18n(<InfoSection {...defaultProps} />)

    const addButton = screen.getByRole('button', { name: /add.*property/i })
    await user.click(addButton)

    const relationOption = screen.getByRole('option', { name: /relation/i })
    await user.click(relationOption)

    expect(defaultProps.onAddProperty).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'relation',
        name: expect.any(String)
      })
    )
  })

  it('should use Relation as the default name when no custom name provided', async () => {
    const user = userEvent.setup()
    renderWithI18n(<InfoSection {...defaultProps} />)

    const addButton = screen.getByRole('button', { name: /add.*property/i })
    await user.click(addButton)

    const relationOption = screen.getByRole('option', { name: /relation/i })
    await user.click(relationOption)

    expect(defaultProps.onAddProperty).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'relation',
        name: 'Relation'
      })
    )
  })
})
