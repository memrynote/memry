import { describe, it, expect, vi, beforeEach } from 'vitest'
import { type ReactElement } from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getTemplateMock } = vi.hoisted(() => ({ getTemplateMock: vi.fn() }))

vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (k: string) => k }) }))
vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => ({ getTemplate: getTemplateMock })
}))
vi.mock('@/components/note/content-area', () => ({
  ContentArea: (props: { initialContent?: string; editable?: boolean }) => (
    <div data-testid="content-area" data-editable={String(props.editable)}>
      {props.initialContent}
    </div>
  )
}))

import { TemplatePreview } from './template-preview'

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const template = {
  id: 'meeting-notes',
  name: 'Meeting Notes',
  description: 'Capture agenda',
  icon: null,
  isBuiltIn: true,
  tags: [],
  properties: [{ name: 'date', type: 'date', value: null }],
  content: '# Meeting\n## Notes',
  createdAt: 0,
  modifiedAt: 0
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TemplatePreview', () => {
  it('renders content read-only with a built-in badge and properties', async () => {
    getTemplateMock.mockResolvedValue(template)
    renderWithQuery(<TemplatePreview templateId="meeting-notes" onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Meeting Notes')).toBeInTheDocument())
    const content = screen.getByTestId('content-area')
    expect(content).toHaveAttribute('data-editable', 'false')
    expect(content).toHaveTextContent('# Meeting')
    expect(screen.getByText('templates.groups.builtIn')).toBeInTheDocument()
    expect(screen.getAllByText('date')).toHaveLength(2)
  })

  it('calls onBack when the back button is clicked', async () => {
    getTemplateMock.mockResolvedValue(template)
    const onBack = vi.fn()
    renderWithQuery(<TemplatePreview templateId="meeting-notes" onBack={onBack} />)
    await waitFor(() => expect(screen.getByText('Meeting Notes')).toBeInTheDocument())
    fireEvent.click(screen.getByText('templates.header.title'))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('shows not-found message (not spinner) when template resolves to null', async () => {
    getTemplateMock.mockResolvedValue(null)
    const onBack = vi.fn()
    renderWithQuery(<TemplatePreview templateId="unknown" onBack={onBack} />)
    // not-found branch renders (spinner is the else branch — cannot coexist)
    await waitFor(() => expect(screen.getByText('templates.preview.notFound')).toBeInTheDocument())
    expect(screen.queryByTestId('content-area')).not.toBeInTheDocument()
    // back button still present and functional
    fireEvent.click(screen.getByText('templates.header.title'))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
