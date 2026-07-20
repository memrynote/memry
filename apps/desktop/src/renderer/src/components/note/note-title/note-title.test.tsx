import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { NoteTitle } from './NoteTitle'

let i18nEn: I18nInstance
let i18nTr: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
  i18nTr = await createRendererI18n({ locale: 'tr' })
})

const renderWithI18n = (ui: React.ReactElement, i18n = i18nEn) =>
  render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)

describe('NoteTitle - title editing', () => {
  const defaultProps = {
    emoji: null,
    title: 'Test Note',
    onTitleChange: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should render with title', () => {
    renderWithI18n(<NoteTitle {...defaultProps} />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    expect(textarea).toHaveValue('Test Note')
  })

  it('should render with placeholder when title is empty', () => {
    renderWithI18n(<NoteTitle {...defaultProps} title="" placeholder="Untitled" />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    expect(textarea).toHaveAttribute('placeholder', 'Untitled')
  })

  it('renders Turkish placeholder for Turkish notes namespace', () => {
    renderWithI18n(<NoteTitle {...defaultProps} title="" />, i18nTr)

    const textarea = screen.getByRole('textbox', { name: 'Not başlığı' })
    expect(textarea).toHaveAttribute('placeholder', 'İsimsiz')
  })

  it('should use custom placeholder', () => {
    renderWithI18n(<NoteTitle {...defaultProps} title="" placeholder="Enter a title..." />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    expect(textarea).toHaveAttribute('placeholder', 'Enter a title...')
  })

  it('should call onTitleChange on blur when value changes', async () => {
    const user = userEvent.setup()
    renderWithI18n(<NoteTitle {...defaultProps} />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    await user.clear(textarea)
    await user.type(textarea, 'New Title')
    await user.tab()

    expect(defaultProps.onTitleChange).toHaveBeenCalledWith('New Title')
  })

  it('should not call onTitleChange if value did not change', async () => {
    const user = userEvent.setup()
    renderWithI18n(<NoteTitle {...defaultProps} />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    await user.click(textarea)
    await user.tab()

    expect(defaultProps.onTitleChange).not.toHaveBeenCalled()
  })

  it('should save on Enter key press', async () => {
    const user = userEvent.setup()
    renderWithI18n(<NoteTitle {...defaultProps} />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    await user.clear(textarea)
    await user.type(textarea, 'Enter Title{enter}')

    expect(defaultProps.onTitleChange).toHaveBeenCalledWith('Enter Title')
  })

  it('should revert and blur on Escape key press', async () => {
    const user = userEvent.setup()
    renderWithI18n(<NoteTitle {...defaultProps} />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    await user.clear(textarea)
    await user.type(textarea, 'Changed Title')
    await user.keyboard('{Escape}')

    expect(textarea).not.toHaveFocus()
    expect(textarea).toHaveValue('Test Note')
  })

  it('should be disabled when disabled prop is true', () => {
    renderWithI18n(<NoteTitle {...defaultProps} disabled />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    expect(textarea).toBeDisabled()
  })

  it('should auto-focus when autoFocus is true', () => {
    renderWithI18n(<NoteTitle {...defaultProps} autoFocus />)

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    expect(textarea).toHaveFocus()
  })
})

describe('NoteTitle - emoji display', () => {
  it('should display emoji when set', () => {
    renderWithI18n(<NoteTitle emoji="📝" title="Test" onTitleChange={vi.fn()} />)

    expect(screen.getByText('📝')).toBeInTheDocument()
  })

  it('should not render emoji container when emoji is null', () => {
    const { container } = renderWithI18n(
      <NoteTitle emoji={null} title="Test" onTitleChange={vi.fn()} />
    )

    expect(container.querySelector('.bg-sidebar-terracotta\\/8')).not.toBeInTheDocument()
  })
})

describe('NoteTitle - accessibility', () => {
  it('should have proper ARIA label on title input', () => {
    renderWithI18n(<NoteTitle emoji={null} title="Test Note" onTitleChange={vi.fn()} />)

    expect(screen.getByRole('textbox', { name: /note title/i })).toBeInTheDocument()
  })
})

describe('NoteTitle - external inputRef (rename from menu)', () => {
  it('forwards an external ref to the underlying textarea so it can be focused', () => {
    const inputRef = { current: null as HTMLTextAreaElement | null }
    renderWithI18n(
      <NoteTitle emoji={null} title="Focus Me" onTitleChange={vi.fn()} inputRef={inputRef} />
    )

    const textarea = screen.getByRole('textbox', { name: /note title/i })
    expect(inputRef.current).toBe(textarea)

    // The "Rename" menu item focuses + selects via this ref
    inputRef.current?.focus()
    inputRef.current?.select()
    expect(textarea).toHaveFocus()
    expect(inputRef.current?.selectionStart).toBe(0)
    expect(inputRef.current?.selectionEnd).toBe('Focus Me'.length)
  })
})
