import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { UrlEditor } from './UrlEditor'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/lib/icons', () => ({
  ExternalLink: ({ className }: { className?: string }) => <span className={className}>open</span>
}))

describe('UrlEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.open = vi.fn()
  })

  it('accepts empty and normalized URL values on blur or Enter', () => {
    const onChange = vi.fn()
    const onBlur = vi.fn()
    const { rerender } = render(
      <UrlEditor value="" onChange={onChange} onBlur={onBlur} placeholder="url" />
    )

    const input = screen.getByPlaceholderText('url')
    fireEvent.change(input, { target: { value: 'memry.test/page' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith('memry.test/page')
    expect(onBlur).toHaveBeenCalled()

    rerender(<UrlEditor value="https://old.test" onChange={onChange} onBlur={onBlur} />)
    fireEvent.change(screen.getByDisplayValue('https://old.test'), {
      target: { value: '' }
    })
    fireEvent.keyDown(screen.getByDisplayValue(''), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('rejects invalid URLs and restores the previous value', () => {
    const onChange = vi.fn()
    const onBlur = vi.fn()
    render(<UrlEditor value="https://valid.test" onChange={onChange} onBlur={onBlur} />)

    const input = screen.getByDisplayValue('https://valid.test')
    fireEvent.change(input, { target: { value: 'invalid' } })
    expect(input).toHaveClass('border-red-500')
    fireEvent.blur(input)

    expect(onChange).not.toHaveBeenCalled()
    expect(onBlur).toHaveBeenCalled()
    expect(screen.getByDisplayValue('https://valid.test')).toBeInTheDocument()
  })

  it('handles Escape, prop value resets, and open-url action', () => {
    const onChange = vi.fn()
    const onBlur = vi.fn()
    const { rerender } = render(
      <UrlEditor value="https://valid.test" onChange={onChange} onBlur={onBlur} autoFocus={false} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'properties.openUrlAria' }))
    expect(window.open).toHaveBeenCalledWith('https://valid.test', '_blank', 'noopener,noreferrer')

    const input = screen.getByDisplayValue('https://valid.test')
    fireEvent.change(input, { target: { value: 'https://changed.test' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onBlur).toHaveBeenCalled()
    expect(screen.getByDisplayValue('https://valid.test')).toBeInTheDocument()

    rerender(
      <UrlEditor value="https://next.test" onChange={onChange} onBlur={onBlur} autoFocus={false} />
    )
    expect(screen.getByDisplayValue('https://next.test')).toBeInTheDocument()
  })
})
