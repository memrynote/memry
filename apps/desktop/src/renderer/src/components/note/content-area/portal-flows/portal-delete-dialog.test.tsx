import { act, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  PortalDeleteDialog,
  usePortalDeleteConfirm,
  type PortalDeleteRequest
} from './portal-delete-dialog'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: { count?: number; title?: string }) => {
      const messages: Record<string, string> = {
        'portalFlows.deleteGuard.title.block': 'Delete this block everywhere?',
        'portalFlows.deleteGuard.description.block': `${values?.title} also appears in ${values?.count} other notes.`,
        'portalFlows.deleteGuard.source': `${values?.title} (source)`,
        'portalFlows.deleteGuard.removeHere': 'Remove from this portal only',
        'portalFlows.deleteGuard.cancel': 'Cancel',
        'portalFlows.deleteGuard.everywhere': 'Delete everywhere'
      }
      return messages[key] ?? key
    }
  })
}))

const host = (noteId: string) => ({
  noteId,
  title: noteId,
  path: `${noteId}.md`,
  count: 1,
  hiddenCount: 0
})

const request = (canRemoveHere: boolean): PortalDeleteRequest => ({
  subject: 'block',
  title: 'Chloroplast',
  sourceTitle: 'Cell Biology',
  hosts: [host('Lab 4'), host('Exam prep')],
  canRemoveHere
})

describe('PortalDeleteDialog', () => {
  it('names the source and every host note', () => {
    render(<PortalDeleteDialog request={request(false)} onChoose={vi.fn()} />)
    expect(screen.getByText('Chloroplast also appears in 2 other notes.')).toBeTruthy()
    expect(screen.getByText('Cell Biology (source)')).toBeTruthy()
    expect(screen.getByText('Lab 4')).toBeTruthy()
    expect(screen.getByText('Exam prep')).toBeTruthy()
  })

  it('offers "remove from this portal only" only inside a portal', () => {
    const { rerender } = render(<PortalDeleteDialog request={request(false)} onChoose={vi.fn()} />)
    expect(screen.queryByText('Remove from this portal only')).toBeNull()
    rerender(<PortalDeleteDialog request={request(true)} onChoose={vi.fn()} />)
    expect(screen.getByText('Remove from this portal only')).toBeTruthy()
  })

  it.each([
    ['Delete everywhere', 'everywhere'],
    ['Remove from this portal only', 'here'],
    ['Cancel', 'cancel']
  ])('%s answers %s first', async (label, choice) => {
    const user = userEvent.setup()
    const onChoose = vi.fn()
    render(<PortalDeleteDialog request={request(true)} onChoose={onChoose} />)
    await user.click(screen.getByText(label))
    // Closing the dialog afterwards reports a cancel too; the hook ignores
    // every answer after the first.
    expect(onChoose).toHaveBeenNthCalledWith(1, choice)
  })

  it('treats Escape as cancel', async () => {
    const user = userEvent.setup()
    const onChoose = vi.fn()
    render(<PortalDeleteDialog request={request(true)} onChoose={onChoose} />)
    await user.keyboard('{Escape}')
    expect(onChoose).toHaveBeenNthCalledWith(1, 'cancel')
  })
})

describe('usePortalDeleteConfirm', () => {
  it('resolves the pending confirm with the answer and closes', async () => {
    const user = userEvent.setup()
    const { result } = renderHook(() => usePortalDeleteConfirm())
    render(<>{result.current.dialog}</>)

    let answer: Promise<string> | undefined
    act(() => {
      answer = result.current.confirm(request(false))
    })
    const { rerender } = render(<>{result.current.dialog}</>)
    rerender(<>{result.current.dialog}</>)
    await user.click(await screen.findByText('Delete everywhere'))
    await expect(answer).resolves.toBe('everywhere')
  })
})
