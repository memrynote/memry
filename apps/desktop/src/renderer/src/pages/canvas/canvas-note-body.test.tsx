import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// The file block's PDF preview pulls pdf.js, which touches `DOMMatrix` at
// import time and jsdom has none.
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))
vi.mock('@blocknote/shadcn', () => ({ BlockNoteView: () => null }))
vi.mock('@/components/note/content-area/task-block/task-prefetch-context', () => ({
  TaskPrefetchProvider: ({ children }: { children: React.ReactNode }) => children
}))

const created = vi.hoisted(() => ({ editor: null as { document: unknown[] } | null }))
vi.mock('@blocknote/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@blocknote/react')>()
  return {
    ...actual,
    useCreateBlockNote: ((...args: Parameters<typeof actual.useCreateBlockNote>) => {
      const editor = actual.useCreateBlockNote(...args)
      created.editor = editor as unknown as { document: unknown[] }
      return editor
    }) as typeof actual.useCreateBlockNote
  }
})

import { CanvasNoteBody } from './canvas-note-body'

describe('CanvasNoteBody', () => {
  it('shows a task line with its markup as written', async () => {
    render(<CanvasNoteBody markdown="- [ ] **Dune** [[Dune (2021)]] x {task:t1}" noteId="n1" />)

    await waitFor(() => {
      expect(created.editor?.document[0]).toMatchObject({
        type: 'taskBlock',
        props: { taskId: 't1', title: '**Dune** [[Dune (2021)]] x' }
      })
    })
  })
})
