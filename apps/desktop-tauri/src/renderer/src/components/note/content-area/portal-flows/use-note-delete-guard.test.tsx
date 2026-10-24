import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortalHost } from './portal-api'
import { useNoteDeleteGuard, type NoteToDelete } from './use-note-delete-guard'

const mocks = vi.hoisted(() => ({ getUsage: vi.fn() }))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))
vi.mock('./portal-api', () => ({ getPortalUsage: mocks.getUsage }))
vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: { count?: number }) =>
      key.startsWith('portalFlows.deleteGuard.description')
        ? `used in ${values?.count}`
        : key.replace('portalFlows.deleteGuard.', '')
  })
}))

const host = (noteId: string, kind: 'portal' | 'link'): PortalHost => ({
  noteId,
  title: `Title ${noteId}`,
  path: `${noteId}.md`,
  count: 1,
  kind
})

function Harness({
  notes,
  onResult
}: {
  notes: NoteToDelete[]
  onResult: (proceed: boolean) => void
}) {
  const guard = useNoteDeleteGuard()
  return (
    <>
      <button onClick={() => void guard.confirmNoteDelete(notes).then(onResult)}>go</button>
      {guard.dialog}
    </>
  )
}

describe('useNoteDeleteGuard', () => {
  beforeEach(() => mocks.getUsage.mockReset())

  it('proceeds without asking when no other note shows or links the note', async () => {
    mocks.getUsage.mockResolvedValue([])
    const onResult = vi.fn()
    render(<Harness notes={[{ id: 'a', title: 'A' }]} onResult={onResult} />)
    await userEvent.click(screen.getByText('go'))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
    expect(screen.queryByTestId('portal-delete-dialog')).toBeNull()
  })

  it('asks when another note links to it, and cancel stops the delete', async () => {
    mocks.getUsage.mockResolvedValue([host('x', 'link')])
    const onResult = vi.fn()
    render(<Harness notes={[{ id: 'a', title: 'A' }]} onResult={onResult} />)
    await userEvent.click(screen.getByText('go'))
    expect(await screen.findByTestId('portal-delete-dialog')).toBeTruthy()
    expect(screen.getByText('Title x')).toBeTruthy()
    await userEvent.click(screen.getByText('cancel'))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false))
  })

  it('deletes on "Delete everywhere"', async () => {
    mocks.getUsage.mockResolvedValue([host('x', 'portal')])
    const onResult = vi.fn()
    render(<Harness notes={[{ id: 'a', title: 'A' }]} onResult={onResult} />)
    await userEvent.click(screen.getByText('go'))
    await userEvent.click(await screen.findByText('everywhere'))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
  })

  it('ignores hosts that are being deleted too and lists each host once', async () => {
    mocks.getUsage.mockImplementation(async (id: string) =>
      id === 'a' ? [host('b', 'portal'), host('x', 'portal')] : [host('x', 'link')]
    )
    const onResult = vi.fn()
    render(
      <Harness
        notes={[
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' }
        ]}
        onResult={onResult}
      />
    )
    await userEvent.click(screen.getByText('go'))
    await screen.findByTestId('portal-delete-dialog')
    expect(screen.getAllByText('Title x')).toHaveLength(1)
    expect(screen.queryByText('Title b')).toBeNull()
    await act(async () => {})
  })

  it('does not block the delete when the lookup fails', async () => {
    // A malformed reply fails the lookup the same way a dead IPC does.
    mocks.getUsage.mockResolvedValue(null)
    const onResult = vi.fn()
    render(<Harness notes={[{ id: 'a', title: 'A' }]} onResult={onResult} />)
    await userEvent.click(screen.getByText('go'))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
  })
})
