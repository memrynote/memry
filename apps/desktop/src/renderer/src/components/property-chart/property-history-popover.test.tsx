/**
 * The journal property's history popover. Its chart is PropertyChart's
 * subject; what is only true here is the hand-off: the block it copies must be
 * one the editor turns back into a chart when it is pasted.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BlockNoteEditor } from '@blocknote/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseViewBlockDefinition } from '@memry/shared/view-block'

const mocks = vi.hoisted(() => ({
  getPropertyRows: vi.fn(),
  writeText: vi.fn()
}))

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/services/journal-service', () => ({
  journalService: { getPropertyRows: mocks.getPropertyRows }
}))
vi.mock('@/hooks/use-property-definitions', () => ({
  usePropertyDefinitions: () => ({ getDefinition: () => undefined })
}))
vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: vi.fn() })
}))

import { editorSchema } from '@/components/note/content-area/editor-schema'
import { PropertyHistoryButton } from './property-history-popover'

describe('PropertyHistoryButton', () => {
  beforeEach(() => {
    mocks.getPropertyRows.mockReset().mockResolvedValue({ rows: [], properties: [] })
    mocks.writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.writeText }
    })
  })

  it('copies a chart block that pastes back as a journal chart of the property', async () => {
    // #given
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PropertyHistoryButton property="mood" propertyType="select" visible />
      </QueryClientProvider>
    )

    // #when
    await userEvent.click(screen.getByRole('button', { name: 'Show history: mood' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Copy as chart block' }))

    // #then the clipboard holds markdown the editor reads as the chart's code block
    const markdown = mocks.writeText.mock.calls[0][0] as string
    const editor = BlockNoteEditor.create({ schema: editorSchema })
    const [block] = await editor.tryParseMarkdownToBlocks(markdown)
    expect(block.type).toBe('codeBlock')
    expect(block.props).toMatchObject({ language: 'memry-view' })
    const text = (block.content as Array<{ text: string }>).map((run) => run.text).join('')
    expect(parseViewBlockDefinition(text)).toMatchObject({
      ok: true,
      definition: { source: { kind: 'journal' }, layout: 'chart', chart: { property: 'mood' } }
    })
  })
})
