// TEMPORARY instrumentation for #3967 FLAKE-6B. Not part of the final change.
import type { Page } from './pw-compat/page'

/** Records window/editor focus, the slash menu appearing and going, and keys, in page memory. */
export async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __probe?: string[] }
    if (w.__probe) return
    const log: string[] = (w.__probe = [])
    const t0 = performance.now()
    const stamp = (what: string): void => {
      log.push(
        `${(performance.now() - t0).toFixed(0)}ms ${what} hasFocus=${document.hasFocus()} vis=${document.visibilityState}`
      )
      if (log.length > 400) log.shift()
    }
    const describe = (target: EventTarget | null): string =>
      target instanceof Element
        ? `${target.tagName.toLowerCase()}.${String(target.className).slice(0, 30)}`
        : String(target)
    window.addEventListener('blur', () => stamp('window blur'), true)
    window.addEventListener('focus', () => stamp('window focus'), true)
    document.addEventListener('focusin', (e) => stamp(`focusin ${describe(e.target)}`), true)
    document.addEventListener('focusout', (e) => stamp(`focusout ${describe(e.target)}`), true)
    document.addEventListener('visibilitychange', () => stamp('visibilitychange'))
    document.addEventListener(
      'keydown',
      (e) => stamp(`keydown ${e.key} active=${describe(document.activeElement)}`),
      true
    )
    let menu = false
    let expanded: string | null = null
    new MutationObserver(() => {
      const nowMenu = document.querySelector('.memry-slash-menu') !== null
      if (nowMenu !== menu) {
        menu = nowMenu
        stamp(`slash menu ${menu ? 'mounted' : 'gone'}`)
      }
      const nowExpanded =
        document.querySelector('.ProseMirror')?.getAttribute('aria-expanded') ?? null
      if (nowExpanded !== expanded) {
        expanded = nowExpanded
        stamp(`aria-expanded ${expanded}`)
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true })
    stamp('probe installed')
  })
}

export async function probeLog(page: Page): Promise<string> {
  try {
    return await page.evaluate(() =>
      ((window as unknown as { __probe?: string[] }).__probe ?? []).slice(-60).join('\n')
    )
  } catch (error) {
    return `probe unreadable: ${String(error)}`
  }
}

/** The editor's selection, focus and the table cell html, for the italic case. */
export async function cellState(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const editor = (window as unknown as { __memryActiveEditor?: { getSelectedText(): string } })
        .__memryActiveEditor
      const cells = [...document.querySelectorAll('.ProseMirror td')].map((td) => td.innerHTML)
      const active = document.activeElement
      return JSON.stringify({
        selectedText: editor?.getSelectedText() ?? null,
        domSelection: String(window.getSelection()),
        hasFocus: document.hasFocus(),
        active: active ? `${active.tagName}.${String(active.className).slice(0, 40)}` : null,
        cells
      })
    })
  } catch (error) {
    return `cell state unreadable: ${String(error)}`
  }
}

/** Why a sidebar row cannot be clicked: its box, what is on top at its centre, and its ancestors. */
export async function rowState(page: Page, nodeId: string): Promise<string> {
  try {
    return await page.evaluate((id: string) => {
      const row = document.querySelector(`[data-tree-node-id="${id}"]`)
      if (!row) return 'row absent'
      const box = row.getBoundingClientRect()
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      const top = document.elementFromPoint(cx, cy)
      const chain: string[] = []
      for (let el: Element | null = row; el && chain.length < 14; el = el.parentElement) {
        const style = getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        chain.push(
          `${el.tagName.toLowerCase()}[${el.id || el.getAttribute('data-testid') || String(el.className).slice(0, 30)}] ` +
            `rect=${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}x${Math.round(rect.height)} ` +
            `ovf=${style.overflowY} scroll=${el.scrollTop}/${el.scrollHeight}/${el.clientHeight} ` +
            `op=${style.opacity} tf=${style.transform === 'none' ? '' : style.transform} vis=${style.visibility} pe=${style.pointerEvents} anim=${el.getAnimations().length}`
        )
      }
      return JSON.stringify({
        center: [Math.round(cx), Math.round(cy)],
        viewport: [window.innerWidth, window.innerHeight],
        top: top ? `${top.tagName.toLowerCase()}.${String(top.className).slice(0, 60)}` : null,
        topIsRowDescendant: top ? row.contains(top) : null,
        hasFocus: document.hasFocus(),
        chain
      })
    }, nodeId)
  } catch (error) {
    return `row state unreadable: ${String(error)}`
  }
}
