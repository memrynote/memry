// FLAKE-7A instrumentation, not for merge (#3967).
import { typeInEditor } from '../../harness/editor'
import { openNoteByTitle } from '../../harness/note-sync-helpers'
import { createNote, NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { expect, test } from '../../harness/test'

const unique = (label: string): string => `${label} ${Math.random().toString(36).slice(2, 8)}`

export function install(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as { __probe: unknown[] }
    const t0 = performance.now()
    const log: unknown[] = (w.__probe = [])
    const push = (k: string, extra?: unknown): void => {
      const ae = document.activeElement
      log.push({
        t: Math.round(performance.now() - t0),
        k,
        hf: document.hasFocus(),
        vis: document.visibilityState,
        ae: ae ? `${ae.tagName}.${String(ae.className).slice(0, 24)}` : null,
        x: extra
      })
    }
    for (const ev of [
      'focus',
      'blur',
      'pointerdown',
      'mousedown',
      'pointerup',
      'click',
      'keydown'
    ]) {
      window.addEventListener(ev, (e) => push(ev, (e.target as HTMLElement)?.tagName), true)
    }
    document.addEventListener('visibilitychange', () => push('vis'))
    document.addEventListener('selectionchange', () => {
      const s = getSelection()
      push('sel', [s?.anchorOffset, s?.focusOffset, s?.isCollapsed])
    })
    const editor = document.querySelector(
      '[aria-label="Rich text editor"] [contenteditable="true"]'
    )
    if (editor) {
      new MutationObserver(() => push('expanded', editor.getAttribute('aria-expanded'))).observe(
        editor,
        { attributes: true, attributeFilter: ['aria-expanded'] }
      )
    }
    push('installed')
  })
}

export function dump(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as { __probe: unknown[] }
    const editor = document.querySelector(
      '[aria-label="Rich text editor"] [contenteditable="true"]'
    )
    return JSON.stringify({
      expanded: editor?.getAttribute('aria-expanded'),
      menu: document.querySelector('.wiki-link-menu')?.textContent?.slice(0, 80),
      text: document.querySelector('.bn-editor')?.textContent?.slice(0, 120),
      log: w.__probe.slice(-60)
    })
  })
}

export function wikiLoop(group: number, count: number): void {
  for (let i = 0; i < count; i++) {
    test(`probe ${group}.${i}`, async ({ page }) => {
      await vaultOpen(page)
      const targetTitle = unique('Continent')
      const sourceTitle = unique('Selection Source')
      const selected = 'kuzeyde bir yer'
      await createNote(page, { title: targetTitle, content: 'Bir kıta.\n' })
      await createNote(page, { title: sourceTitle, content: `${selected}\n` })
      await openNoteByTitle(page, sourceTitle)
      await install(page)
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
      try {
        await expect(page.locator('.wiki-link-menu [role="option"]').first()).toHaveText(
          targetTitle,
          { timeout: 8000 }
        )
        await expect
          .poll(
            () =>
              page.evaluate(
                (sel: string) =>
                  document.querySelector(sel)?.getAttribute('aria-expanded') === 'true',
                NOTE_EDITOR
              ),
            { timeout: 8000 }
          )
          .toBe(true)
      } catch (error) {
        throw new Error(
          `PROBE-WIKI ${(error as Error).message.slice(0, 120)} ${await dump(page)}`,
          { cause: error }
        )
      }
    })
  }
}
