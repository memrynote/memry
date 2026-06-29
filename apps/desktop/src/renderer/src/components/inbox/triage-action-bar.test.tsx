import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TriageActionBar } from './triage-action-bar'

// Minimal i18n mock — just return the key
vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (k: string) => k })
}))

const noop = () => {}
const baseProps = {
  itemType: undefined as const,
  activePicker: null as const,
  onPickerChange: noop,
  onDiscard: noop,
  onConvertToTask: noop,
  onExpandToNote: noop,
  onOpenTarget: noop,
  disabled: false
}

describe('TriageActionBar tasks gating', () => {
  it('hides the to-task action when tasks are disabled', () => {
    render(<TriageActionBar {...baseProps} tasksEnabled={false} />)
    expect(screen.queryByText('triage.action.toTask')).toBeNull()
  })

  it('shows the to-task action when tasks are enabled', () => {
    render(<TriageActionBar {...baseProps} tasksEnabled={true} />)
    expect(screen.getByText('triage.action.toTask')).toBeTruthy()
  })
})
