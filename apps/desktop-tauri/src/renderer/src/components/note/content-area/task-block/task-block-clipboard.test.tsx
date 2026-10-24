import { describe, expect, it } from 'vitest'
import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core'
import { createTaskBlock } from './index'

// #2659: ⌘C over a task block put the row's <style> rules and project chip on
// the clipboard's text/plain. BlockNote's copy writes text/html from the
// external-HTML exporter and text/plain as that HTML's markdown — the same two
// exports these call. Left unmounted: a React spec renders its export through
// react-dom only on a headless editor; a mounted one needs a BlockNoteView.
function exportTask(): { html: string; markdown: string } {
  const editor = BlockNoteEditor.create({
    schema: BlockNoteSchema.create({
      blockSpecs: { ...defaultBlockSpecs, taskBlock: createTaskBlock() }
    })
  })
  const blocks = [
    { type: 'taskBlock', props: { taskId: 'task-1', title: 'Buy milk', checked: true } }
  ] as never
  return { html: editor.blocksToHTMLLossy(blocks), markdown: editor.blocksToMarkdownLossy(blocks) }
}

describe('task block copy', () => {
  it('exports the task as its checkbox line, without CSS or the project chip', () => {
    const { html, markdown } = exportTask()
    expect(markdown).toBe('* [x] Buy milk {task:task-1}\n')
    expect(html).not.toContain('<style')
  })
})
