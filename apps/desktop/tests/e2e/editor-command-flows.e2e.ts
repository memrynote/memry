import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { MOD, PNG_BYTES, ready, uniqueLabel } from './utils/desktop-test-helpers'
import { createNote, SELECTORS } from './utils/electron-helpers'

async function focusEditor(page: Page) {
  const editor = page.locator(SELECTORS.noteEditor).first()
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  await editor.click()
  return editor
}

async function resetEditorDocument(page: Page, content = ''): Promise<void> {
  await page.evaluate((initialContent) => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    editor.replaceBlocks(editor.document, [
      {
        type: 'paragraph',
        content: initialContent ? [{ type: 'text', text: initialContent, styles: {} }] : ''
      }
    ])
    const firstBlock = editor.document[0]
    if (firstBlock) editor.setTextCursorPosition(firstBlock.id, 'end')
  }, content)
}

async function editorBlockTypes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    return editor.document.map((block: any) => block.type as string)
  })
}

async function chooseSlashItem(
  page: Page,
  query: string,
  label: string,
  content = ''
): Promise<void> {
  await resetEditorDocument(page, content)
  await focusEditor(page)
  await page.keyboard.type(`/${query}`)
  await expect(page.getByText(label).first()).toBeVisible()
  await page.keyboard.press('Enter')
}

async function firstBlockHasBoldText(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const editor = (window as any).__memryEditor
    if (!editor) throw new Error('window.__memryEditor not exposed')
    const content = editor.document[0]?.content
    if (!Array.isArray(content)) return false
    return content.some((part: any) => Boolean(part.styles?.bold))
  })
}

async function pastePlainText(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const editable = document.querySelector('[contenteditable="true"]')
    if (!editable) throw new Error('contenteditable editor not found')

    const dataTransfer = new DataTransfer()
    dataTransfer.setData('text/plain', value)
    editable.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer
      })
    )
  }, text)
}

test.describe('Editor command flows E2E', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page)
  })

  test('inserts slash command blocks and applies formatting toolbar marks', async ({ page }) => {
    await createNote(page, uniqueLabel('Slash Commands'))

    await chooseSlashItem(page, 'callout', 'Callout')
    await expect.poll(() => editorBlockTypes(page)).toContain('callout')

    await resetEditorDocument(page, 'Bold from toolbar')
    await focusEditor(page)
    await page.keyboard.press(`${MOD}+a`)
    await page.getByRole('button', { name: 'Bold' }).first().click()
    await expect.poll(() => firstBlockHasBoldText(page)).toBe(true)
  })

  test('uploads dropped files and embeds pasted YouTube links into editor blocks', async ({
    page
  }) => {
    const title = uniqueLabel('Editor Drop')
    await createNote(page, title)
    await focusEditor(page)

    await page.evaluate((pngBytes) => {
      const container = document.querySelector('.bn-container')
      if (!container) throw new Error('BlockNote container not found')

      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(
        new File([new Uint8Array(pngBytes)], 'drop-image.png', { type: 'image/png' })
      )
      dataTransfer.items.add(new File(['drop text'], 'drop-note.txt', { type: 'text/plain' }))

      for (const type of ['dragenter', 'dragover', 'drop']) {
        container.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer
          })
        )
      }
    }, PNG_BYTES)

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const editor = (window as any).__memryEditor
            if (!editor) throw new Error('window.__memryEditor not exposed')
            return {
              blockTypes: editor.document.map((block: any) => block.type as string),
              props: editor.document.map((block: any) => block.props ?? {})
            }
          }),
        { timeout: 20_000 }
      )
      .toMatchObject({
        blockTypes: expect.arrayContaining(['image', 'file'])
      })

    const attachmentNames = await page.evaluate(
      async ({ noteTitle }) => {
        const notes = await window.api.notes.list({ limit: 100 })
        const note = notes.notes.find((item) => item.title === noteTitle)
        if (!note) return []
        const attachments = await window.api.notes.listAttachments(note.id)
        return attachments.map((attachment) => attachment.filename)
      },
      { noteTitle: title }
    )

    expect(attachmentNames.some((name) => name.endsWith('drop-image.png'))).toBe(true)
    expect(attachmentNames.some((name) => name.endsWith('drop-note.txt'))).toBe(true)

    await resetEditorDocument(page, '')
    await focusEditor(page)
    await pastePlainText(page, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    await expect(page.locator('[data-paste-link-menu]')).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await expect
      .poll(() =>
        page.evaluate(() => {
          const editor = (window as any).__memryEditor
          if (!editor) throw new Error('window.__memryEditor not exposed')
          return editor.document.map((block: any) => ({
            type: block.type,
            props: block.props ?? {}
          }))
        })
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'youtubeEmbed',
            props: expect.objectContaining({ videoId: 'dQw4w9WgXcQ' })
          })
        ])
      )
  })

  test('opens AI inline commands, invokes a selection command, and cancels the menu', async ({
    page
  }) => {
    await page.evaluate(async () => {
      await window.electron.ipcRenderer.invoke('ai-inline:set-settings', {
        enabled: true,
        provider: 'ollama',
        model: 'e2e-ai',
        baseUrl: 'http://127.0.0.1:1/v1'
      })
      const result = (await window.electron.ipcRenderer.invoke('ai-inline:start-server')) as {
        success: boolean
        error?: string
      }
      if (!result.success) throw new Error(result.error ?? 'failed to start AI server')
    })

    await page.reload()
    await ready(page)
    await createNote(page, uniqueLabel('AI Commands'), 'rough paragraph for ai selection')
    await focusEditor(page)

    await expect
      .poll(() =>
        page.evaluate(() => {
          const editor = (window as any).__memryEditor
          return Boolean(editor?.getExtension?.('ai'))
        })
      )
      .toBe(true)

    await page.evaluate(() => {
      const editor = (window as any).__memryEditor
      const ai = editor?.getExtension?.('ai')
      if (!ai) throw new Error('AI extension not registered')
      ;(window as any).__memryAiInvocations = []
      ai.invokeAI = async (input: any) => {
        ;(window as any).__memryAiInvocations.push({
          userPrompt: input.userPrompt,
          useSelection: input.useSelection
        })
        await new Promise<void>((resolve) => {
          ;(window as any).__memryResolveAiInvocation = resolve
        })
      }
    })

    await page.keyboard.press(`${MOD}+a`)
    await page.keyboard.press(`${MOD}+j`)
    await expect(page.getByText('Summarize').first()).toBeVisible()
    await page.getByText('Summarize').first().click()

    await expect
      .poll(() => page.evaluate(() => (window as any).__memryAiInvocations ?? []))
      .toEqual([
        expect.objectContaining({
          userPrompt: expect.stringContaining('Summarize')
        })
      ])

    await page.keyboard.press('Escape')
    await expect(page.getByText('Summarize').first()).toBeHidden()
    await page.evaluate(async () => {
      ;(window as any).__memryResolveAiInvocation?.()
      await window.electron.ipcRenderer.invoke('ai-inline:stop-server')
    })
  })
})
