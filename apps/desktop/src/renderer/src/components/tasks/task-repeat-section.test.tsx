import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TaskRepeatSection } from './task-repeat-section'
import type { RepeatConfig } from '@/data/sample-tasks'

vi.mock('@/lib/repeat-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repeat-utils')>()
  return {
    ...actual,
    getRepeatDisplayText: vi.fn((config: RepeatConfig) => {
      if (config.frequency === 'weekly' && config.interval === 1) return 'Every week on Monday'
      if (config.frequency === 'daily') return 'Every day'
      return 'Every week'
    })
  }
})

const weeklyConfig: RepeatConfig = {
  frequency: 'weekly',
  interval: 1,
  daysOfWeek: [1],
  endType: 'never',
  completedCount: 3,
  createdAt: new Date('2026-01-01')
}

const defaultProps = {
  taskTitle: 'Test Task',
  repeatConfig: null as RepeatConfig | null,
  isRepeating: false,
  dueDate: new Date('2026-04-15'),
  projectColor: '#6366F1',
  onRepeatChange: vi.fn()
}

describe('TaskRepeatSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('not repeating', () => {
    it('renders section label and add button', () => {
      render(<TaskRepeatSection {...defaultProps} />)

      expect(screen.getByText('Repeat')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /add repeat/i })).toBeInTheDocument()
    })

    it('does not render info box or edit/stop buttons', () => {
      render(<TaskRepeatSection {...defaultProps} />)

      expect(screen.queryByText('Edit')).not.toBeInTheDocument()
      expect(screen.queryByText('Stop repeating')).not.toBeInTheDocument()
    })
  })

  describe('repeating', () => {
    const repeatingProps = {
      ...defaultProps,
      isRepeating: true,
      repeatConfig: weeklyConfig
    }

    it('renders section label and repeat icon', () => {
      render(<TaskRepeatSection {...repeatingProps} />)

      expect(screen.getByText('Repeat')).toBeInTheDocument()
    })

    it('renders display text and info line', () => {
      render(<TaskRepeatSection {...repeatingProps} />)

      expect(screen.getByText('Every week on Monday')).toBeInTheDocument()
      expect(screen.getByText(/From: Due date/)).toBeInTheDocument()
      expect(screen.getByText(/Done: 3x/)).toBeInTheDocument()
    })

    it('renders Edit and Stop repeating buttons', () => {
      render(<TaskRepeatSection {...repeatingProps} />)

      expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /stop repeating/i })).toBeInTheDocument()
    })

    it('does not render add button when repeating', () => {
      render(<TaskRepeatSection {...repeatingProps} />)

      expect(screen.queryByRole('button', { name: /add repeat/i })).not.toBeInTheDocument()
    })
  })

  describe('edit flow', () => {
    const repeatingProps = {
      ...defaultProps,
      isRepeating: true,
      repeatConfig: weeklyConfig
    }

    it('opens CustomRepeatDialog when Edit is clicked', async () => {
      const user = userEvent.setup()
      render(<TaskRepeatSection {...repeatingProps} />)

      await user.click(screen.getByRole('button', { name: /edit/i }))

      expect(screen.getByText('Custom Repeat')).toBeInTheDocument()
    })
  })

  describe('stop flow', () => {
    const repeatingProps = {
      ...defaultProps,
      isRepeating: true,
      repeatConfig: weeklyConfig
    }

    it('opens StopRepeatingDialog when Stop repeating is clicked', async () => {
      const user = userEvent.setup()
      render(<TaskRepeatSection {...repeatingProps} />)

      await user.click(screen.getByRole('button', { name: /stop repeating/i }))

      expect(screen.getByText('Stop Repeating')).toBeInTheDocument()
    })
  })

  describe('add flow', () => {
    it('opens CustomRepeatDialog when add button is clicked', async () => {
      const user = userEvent.setup()
      render(<TaskRepeatSection {...defaultProps} />)

      await user.click(screen.getByRole('button', { name: /add repeat/i }))

      expect(screen.getByText('Custom Repeat')).toBeInTheDocument()
    })
  })

  describe('theme compliance', () => {
    it('uses CSS variable classes, no hardcoded hex', () => {
      const { container } = render(
        <TaskRepeatSection {...defaultProps} isRepeating={true} repeatConfig={weeklyConfig} />
      )

      const section = container.firstChild as HTMLElement
      const htmlString = section.innerHTML

      const hexPattern = /#[0-9a-fA-F]{6}/g
      const matches = htmlString.match(hexPattern) || []
      const nonProjectColorHex = matches.filter((m) => m !== '#6366F1')
      expect(nonProjectColorHex).toHaveLength(0)
    })
  })
})
