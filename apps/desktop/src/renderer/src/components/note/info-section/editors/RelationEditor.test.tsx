import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { RelationEditor } from './RelationEditor'
import type { ResolvedRelationRef } from '@memry/contracts/properties-api'

const mocks = vi.hoisted(() => ({
  resolveRefs: vi.fn()
}))

vi.mock('@/services/properties-service', () => ({
  propertiesService: {
    resolveRefs: mocks.resolveRefs
  }
}))

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

const renderWithI18n = (ui: React.ReactElement) =>
  render(<I18nextProvider i18n={i18nEn}>{ui}</I18nextProvider>)

function mockResolveRefs(refs: ResolvedRelationRef[]): void {
  mocks.resolveRefs.mockResolvedValue(refs)
}

describe('RelationEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders one chip per resolved ref', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_1',
        targetType: 'note',
        targetId: 'nte_1',
        title: 'Richard Doe',
        exists: true
      }
    ])
    renderWithI18n(<RelationEditor value={['memry://note/nte_1']} onChange={vi.fn()} />)
    expect(await screen.findByText('Richard Doe')).toBeInTheDocument()
    expect(mocks.resolveRefs).toHaveBeenCalledWith(['memry://note/nte_1'])
  })

  it('renders a deleted chip for a missing target and keeps the value', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_gone',
        targetType: 'note',
        targetId: 'nte_gone',
        title: '',
        exists: false
      }
    ])
    const onChange = vi.fn()
    renderWithI18n(<RelationEditor value={['memry://note/nte_gone']} onChange={onChange} />)
    expect(await screen.findByTestId('relation-chip-deleted')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes a chip through onChange without mutating the input array', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_1',
        targetType: 'note',
        targetId: 'nte_1',
        title: 'Richard Doe',
        exists: true
      },
      {
        uri: 'memry://task/tsk_2',
        targetType: 'task',
        targetId: 'tsk_2',
        title: 'Call',
        exists: true
      }
    ])
    const value = ['memry://note/nte_1', 'memry://task/tsk_2']
    const onChange = vi.fn()
    renderWithI18n(<RelationEditor value={value} onChange={onChange} />)
    await userEvent.click(await screen.findByLabelText('Remove Richard Doe'))
    expect(onChange).toHaveBeenCalledWith(['memry://task/tsk_2'])
    expect(value).toEqual(['memry://note/nte_1', 'memry://task/tsk_2'])
  })

  it('renders nothing but stays mounted for an empty value', () => {
    const { container } = renderWithI18n(<RelationEditor value={[]} onChange={vi.fn()} />)
    expect(screen.queryByTestId('relation-chip')).not.toBeInTheDocument()
    expect(mocks.resolveRefs).not.toHaveBeenCalled()
    expect(container).toBeInTheDocument()
  })

  it('re-resolves when value changes', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_1',
        targetType: 'note',
        targetId: 'nte_1',
        title: 'Richard Doe',
        exists: true
      }
    ])
    const { rerender } = renderWithI18n(
      <RelationEditor value={['memry://note/nte_1']} onChange={vi.fn()} />
    )
    expect(await screen.findByText('Richard Doe')).toBeInTheDocument()

    mockResolveRefs([
      {
        uri: 'memry://task/tsk_2',
        targetType: 'task',
        targetId: 'tsk_2',
        title: 'Call',
        exists: true
      }
    ])
    rerender(
      <I18nextProvider i18n={i18nEn}>
        <RelationEditor value={['memry://task/tsk_2']} onChange={vi.fn()} />
      </I18nextProvider>
    )
    expect(await screen.findByText('Call')).toBeInTheDocument()
  })
})
