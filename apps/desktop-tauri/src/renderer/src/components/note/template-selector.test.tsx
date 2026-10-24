import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TemplateSelector } from './template-selector'

vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => ({
    templates: [{ id: 'blank', name: 'Blank Note', description: '', icon: '📄', isBuiltIn: true }],
    isLoading: false
  })
}))

describe('TemplateSelector apply mode', () => {
  it('shows the Apply label and hides the folder-default checkbox', () => {
    render(
      <TemplateSelector
        isOpen
        applyMode
        folderPath="projects"
        onSetFolderDefault={vi.fn()}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByText('Apply Template')).toBeInTheDocument()
    expect(screen.queryByText('Set as folder default')).not.toBeInTheDocument()
  })
})
