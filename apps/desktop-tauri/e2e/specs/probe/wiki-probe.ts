// FLAKE-7A instrumentation, not for merge (#3967).
import { typeInEditor } from '../../harness/editor'
import { openNoteByTitle } from '../../harness/note-sync-helpers'
import { createNote, NOTE_EDITOR, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { expect, test } from '../../harness/test'

const unique = (label: string): string => `${label} ${Math.random().toString(36).slice(2, 8)}`

export type Variant = 'click3' | 'stub-fixup' | 'raw'

export function install(page: Page, stubFixup: boolean): Promise<void> {
  return page.evaluate((stub: boolean) => {
    const w = window as unknown as { __probe: unknown[] }
    const t0 = performance.now()
    const log: unknown[] = (w.__probe = [])
    const push = (k: string, extra?: unknown): void => {
      if ((window as unknown as { __probeStop?: boolean }).__probeStop) return
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
    const stack = (): string =>
      (new Error().stack ?? '')
        .split('\n')
        .slice(2, 6)
        .map((l) => l.trim().slice(0, 90))
        .join(' < ')
    for (const ev of [
      'focus',
      'blur',
      'focusin',
      'focusout',
      'pointerdown',
      'mousedown',
      'pointerup',
      'mouseup',
      'click',
      'dblclick',
      'selectstart',
      'keydown'
    ]) {
      window.addEventListener(
        ev,
        (e) =>
          push(ev, [
            (e.target as HTMLElement)?.tagName,
            e.isTrusted ? 'T' : 'syn',
            (e as MouseEvent).detail
          ]),
        true
      )
    }
    document.addEventListener('visibilitychange', () => push('vis'))
    document.addEventListener('selectionchange', () => {
      const s = getSelection()
      push('sel', [s?.anchorOffset, s?.focusOffset, s?.isCollapsed, s?.toString().length])
    })
    const wrap = (target: unknown, name: string, live?: (self: unknown) => boolean): void => {
      const proto = target as Record<string, unknown>
      const orig = proto[name] as (...a: unknown[]) => unknown
      proto[name] = function (this: unknown, ...args: unknown[]) {
        if (!live || live(this)) push(`call:${name}`, stack())
        return orig.apply(this, args)
      }
    }
    const liveRange = (self: unknown): boolean => {
      const s = getSelection()
      return !!s && s.rangeCount > 0 && s.getRangeAt(0) === self
    }
    wrap(HTMLElement.prototype, 'focus')
    wrap(HTMLElement.prototype, 'blur')
    for (const m of ['setStart', 'setEnd', 'collapse', 'selectNode', 'selectNodeContents']) {
      wrap(Range.prototype, m, liveRange)
    }
    for (const m of [
      'collapse',
      'collapseToStart',
      'collapseToEnd',
      'removeAllRanges',
      'empty',
      'addRange',
      'setBaseAndExtent',
      'extend',
      'selectAllChildren',
      'modify'
    ]) {
      wrap(Selection.prototype, m)
    }
    const pw = (window as unknown as { __memryPw?: Record<string, (...a: unknown[]) => unknown> })
      .__memryPw
    if (pw) {
      const realFixup = pw.fixup
      pw.fixup = (...args: unknown[]) => {
        push('fixup-in', args)
        const result = stub ? true : realFixup(...args)
        push('fixup-out', stub ? 'stub' : 'real')
        return result
      }
    }
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
  }, stubFixup)
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
      log: w.__probe.slice(0, 160)
    })
  })
}

export function mark(page: Page, label: string): Promise<void> {
  return page.evaluate((k: string) => {
    const w = window as unknown as { __probe: unknown[]; __probeStop?: boolean }
    const s = getSelection()
    if (!w.__probeStop)
      w.__probe.push({ k: `MARK:${k}`, x: [s?.anchorOffset, s?.focusOffset, s?.isCollapsed] })
  }, label)
}

export function wikiLoop(group: number, count: number, variant: Variant): void {
  for (let i = 0; i < count; i++) {
    test(`probe ${variant} ${group}.${i}`, async ({ page }) => {
      await vaultOpen(page)
      const targetTitle = unique('Continent')
      const sourceTitle = unique('Selection Source')
      const selected = 'kuzeyde bir yer'
      await createNote(page, { title: targetTitle, content: 'Bir kıta.\n' })
      await createNote(page, { title: sourceTitle, content: `${selected}\n` })
      await openNoteByTitle(page, sourceTitle)
      const editor = page.locator(NOTE_EDITOR).first()
      await editor.click()
      const text = editor.getByText(selected, { exact: false }).first()
      await install(page, variant === 'stub-fixup')
      if (variant === 'raw') {
        const box = await text.boundingBox()
        if (!box) throw new Error('PROBE-WIKI no box')
        const x = box.x + box.width / 2
        const y = box.y + box.height / 2
        await page.mouse.move(x, y)
        for (let n = 0; n < 3; n++) {
          await page.mouse.down()
          await page.mouse.up()
        }
      } else {
        await text.click({ clickCount: 3 })
      }
      await mark(page, 'afterClick')
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 400)))
      const linkButton = page.locator('[data-test="link-to-note"]').first()
      await expect(linkButton).toBeEnabled()
      await mark(page, 'beforeButton')
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
      await page.evaluate(() => {
        ;(window as unknown as { __probeStop?: boolean }).__probeStop = true
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
          `PROBE-WIKI-${variant} ${(error as Error).message.slice(0, 120)} ${await dump(page)}`,
          { cause: error }
        )
      }
    })
  }
}
