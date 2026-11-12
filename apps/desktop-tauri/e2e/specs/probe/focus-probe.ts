// FLAKE-7E probe, not for merge (#3967).
import { expectSuggestionMenuOpen, noteBody, typeInEditor } from '../../harness/editor'
import { openNoteByTitle } from '../../harness/note-sync-helpers'
import { createNote, NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import { test, expect } from '../../harness/test'

const unique = (label: string): string => `${label} ${Math.random().toString(36).slice(2, 8)}`

export function bareLoop(group: number, count: number, focus: boolean): void {
  for (let i = 0; i < count; i++) {
    test(`bare ce focus=${focus} ${group}.${i}`, async ({ page }) => {
      await vaultOpen(page)
      const result = await page.evaluate(
        (arg: { focus: boolean }) =>
          new Promise<string>((resolve) => {
            const el = document.createElement('div')
            el.contentEditable = 'true'
            el.style.cssText =
              'position:fixed;top:4px;left:4px;z-index:99999;background:#fff;color:#000;padding:4px'
            el.textContent = 'kuzeyde bir yer'
            document.body.append(el)
            if (arg.focus) el.focus()
            const node = el.firstChild as Text
            getSelection()?.setBaseAndExtent(node, 0, node, node.length)
            const hf = document.hasFocus()
            const t0 = performance.now()
            const tick = (): void => {
              const dt = Math.round(performance.now() - t0)
              if (getSelection()?.isCollapsed) return resolve(`hf=${hf} collapsed@${dt}`)
              if (dt > 1800) return resolve(`hf=${hf} held`)
              setTimeout(tick, 4)
            }
            tick()
          }),
        { focus }
      )
      console.log(`PROBE-BARE ${group}.${i} focus=${focus} ${result}`)
      expect(result).toMatch(/^hf=true held$/)
    })
  }
}

export function realLoop(group: number, count: number): void {
  for (let i = 0; i < count; i++) {
    test(`real spec ${group}.${i}`, async ({ page }) => {
      await vaultOpen(page)
      const hf = await page.evaluate(() => document.hasFocus())
      expect(hf).toBe(true)
      const targetTitle = unique('Continent')
      const sourceTitle = unique('Selection Source')
      const selected = 'kuzeyde bir yer'
      await createNote(page, { title: targetTitle, content: 'Bir kıta.\n' })
      const source = await createNote(page, { title: sourceTitle, content: `${selected}\n` })
      await openNoteByTitle(page, sourceTitle)
      const editor = page.locator(NOTE_EDITOR).first()
      await editor.click()
      await editor.getByText(selected, { exact: false }).first().click({ clickCount: 3 })
      const linkButton = page.locator('[data-test="link-to-note"]').first()
      await expect(linkButton).toBeEnabled()
      await linkButton.evaluate((button: HTMLElement) => {
        const { left, top, width, height } = button.getBoundingClientRect()
        const at = { bubbles: true, cancelable: true, composed: true, button: 0 }
        const point = { ...at, clientX: left + width / 2, clientY: top + height / 2 }
        const pointer = { ...point, pointerId: 1, pointerType: 'mouse', isPrimary: true }
        button.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }))
        button.dispatchEvent(new MouseEvent('mousedown', { ...point, buttons: 1, detail: 1 }))
        button.dispatchEvent(new PointerEvent('pointerup', pointer))
        button.dispatchEvent(new MouseEvent('mouseup', { ...point, detail: 1 }))
        button.dispatchEvent(new MouseEvent('click', { ...point, detail: 1 }))
      })
      await typeInEditor(page, targetTitle)
      const noteRow = page.locator('.wiki-link-menu [role="option"]').first()
      await expect(noteRow).toHaveText(targetTitle)
      await expectSuggestionMenuOpen(page)
      await noteRow.click()
      await expect
        .poll(() => noteBody(page, source.id), { timeout: 15_000 })
        .toContain(`[[${targetTitle}|${selected}]]`)
    })
  }
}
